import OpenAI from "openai";
import { storage } from "../storage";
import { featureFlagService } from "./feature-flags";
import { sanitizeString } from "../utils/sanitizer";
import { retrieveContext, formatContextForPrompt, type RetrievalResult, type RetrievedChunk } from "./rag-retrieval";
import { selectFewShotExamples, buildFewShotPromptBlock, type FewShotConfig } from "./few-shot-builder";
import {
  type DecisionSettings,
  type DecisionType,
  type IntentType,
  type Penalty,
  type ConfidenceBreakdown,
  type UsedSource,
  type SuggestionResponse,
  type Product,
  type KnowledgeDoc,
  type Tenant,
  type CustomerMemory,
  PENALTY_CODES,
  INTENT_TYPES,
  VEHICLE_LOOKUP_INTENTS,
} from "@shared/schema";

const openai = new OpenAI({
  apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY || process.env.OPENAI_API_KEY,
  baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL || undefined,
});

const CONFIDENCE_WEIGHTS = {
  similarity: 0.45,
  intent: 0.25,
  selfCheck: 0.30,
};

const DEFAULT_SETTINGS: DecisionSettings = {
  tenantId: "",
  tAuto: 0.80,
  tEscalate: 0.40,
  autosendAllowed: false,
  intentsAutosendAllowed: ["price", "availability", "shipping", "other"],
  intentsForceHandoff: ["discount", "complaint"],
  updatedAt: new Date(),
};

export interface GenerationContext {
  conversationId: string;
  tenantId: string;
  tenant: Tenant;
  customerMessage: string;
  conversationHistory: { role: "user" | "assistant"; content: string }[];
  products: Product[];
  docs: KnowledgeDoc[];
  customerMemory?: CustomerMemory | null;
}

const TOPIC_LABELS: Record<string, string> = {
  price: "Цена",
  availability: "Наличие",
  shipping: "Доставка",
  return: "Возврат",
  discount: "Скидки",
  complaint: "Жалобы",
  other: "Прочее",
};

export function buildCustomerContextBlock(memory: CustomerMemory | null | undefined): string | null {
  if (!memory) return null;
  
  const parts: string[] = [];
  
  const prefs = memory.preferences as Record<string, string> | null;
  if (prefs && Object.keys(prefs).length > 0) {
    const prefLines: string[] = [];
    if (prefs.city) prefLines.push(`- Город: ${sanitizeString(prefs.city)}`);
    if (prefs.delivery) prefLines.push(`- Предпочтительная доставка: ${sanitizeString(prefs.delivery)}`);
    if (prefs.payment) prefLines.push(`- Предпочтительная оплата: ${sanitizeString(prefs.payment)}`);
    if (prefLines.length > 0) {
      parts.push("Предпочтения клиента:\n" + prefLines.join("\n"));
    }
  }
  
  if (memory.lastSummaryText) {
    parts.push(`Краткое резюме: ${sanitizeString(memory.lastSummaryText)}`);
  }
  
  const topics = memory.frequentTopics as Record<string, number> | null;
  if (topics && Object.keys(topics).length > 0) {
    const sorted = Object.entries(topics)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
      .map(([topic, count]) => `${TOPIC_LABELS[topic] || topic} (${count}x)`);
    if (sorted.length > 0) {
      parts.push("Частые темы запросов: " + sorted.join(", "));
    }
  }
  
  if (parts.length === 0) return null;
  
  return "CUSTOMER CONTEXT (use as hints, do not override KB/Products facts):\n" + parts.join("\n");
}

export interface DecisionResult {
  replyText: string;
  intent: string | null; // IntentType | VehicleLookupIntentType
  confidence: ConfidenceBreakdown;
  decision: DecisionType;
  explanations: string[];
  penalties: Penalty[];
  missingFields: string[];
  usedSources: UsedSource[];
  needsApproval: boolean;
  needsHandoff: boolean;
  // Triple lock autosend fields
  autosendEligible: boolean;
  autosendBlockReason?: "FLAG_OFF" | "SETTING_OFF" | "INTENT_NOT_ALLOWED";
  // Self-check handoff info
  selfCheckNeedHandoff: boolean;
  selfCheckReasons: string[];
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

const STALE_DATA_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours
const LOW_SIMILARITY_THRESHOLD = 0.5;

function convertRetrievalToSources(retrieval: RetrievalResult): {
  sources: UsedSource[];
  conflicts: boolean;
  hasStaleData: boolean;
  maxSimilarity: number;
} {
  const sources: UsedSource[] = [];
  const prices: number[] = [];
  let hasStaleData = false;
  const now = Date.now();

  for (const chunk of retrieval.productChunks) {
    const metadata = chunk.metadata as Record<string, unknown>;
    sources.push({
      type: "product",
      id: chunk.sourceId,
      title: (metadata.productName as string) || (metadata.sku as string) || "Товар",
      quote: chunk.chunkText.slice(0, 200),
      similarity: chunk.similarity,
    });
    if (metadata.chunkType === "price" && typeof metadata.price === "number") {
      prices.push(metadata.price);
    }
    
    if (metadata.priceVersion && typeof metadata.priceVersion === "number") {
      const age = now - metadata.priceVersion;
      if (age > STALE_DATA_THRESHOLD_MS) {
        hasStaleData = true;
      }
    }
  }

  for (const chunk of retrieval.docChunks) {
    const metadata = chunk.metadata as Record<string, unknown>;
    sources.push({
      type: "doc",
      id: chunk.sourceId,
      title: (metadata.docTitle as string) || (metadata.category as string) || "Документ",
      quote: chunk.chunkText.slice(0, 200),
      similarity: chunk.similarity,
    });
  }

  const conflicts = prices.length > 1 && new Set(prices).size > 1;
  const maxSimilarity = sources.length > 0 
    ? Math.max(...sources.map(s => s.similarity || 0)) 
    : 0;

  return { sources, conflicts, hasStaleData, maxSimilarity };
}

function calculateSimilarityScoreFromRetrieval(retrieval: RetrievalResult): {
  score: number;
  sources: UsedSource[];
  conflicts: boolean;
  hasStaleData: boolean;
  lowSimilarity: boolean;
} {
  const { sources, conflicts, hasStaleData, maxSimilarity } = convertRetrievalToSources(retrieval);
  
  if (sources.length === 0) {
    return { score: 0, sources: [], conflicts: false, hasStaleData: false, lowSimilarity: true };
  }

  const lowSimilarity = maxSimilarity < LOW_SIMILARITY_THRESHOLD;
  return { score: maxSimilarity, sources, conflicts, hasStaleData, lowSimilarity };
}

function calculateSimilarityScoreFallback(products: Product[], docs: KnowledgeDoc[]): {
  score: number;
  sources: UsedSource[];
  conflicts: boolean;
} {
  const sources: UsedSource[] = [];
  const prices: number[] = [];

  for (const p of products.slice(0, 3)) {
    sources.push({
      type: "product",
      id: p.id,
      title: p.name,
      quote: `${p.name}: ${p.price} ${p.currency}`,
      similarity: 0.85 + Math.random() * 0.10,
    });
    if (p.price) prices.push(p.price);
  }

  for (const d of docs.slice(0, 3)) {
    sources.push({
      type: "doc",
      id: d.id,
      title: d.title,
      quote: d.content.slice(0, 100) + "...",
      similarity: 0.80 + Math.random() * 0.15,
    });
  }

  if (sources.length === 0) {
    return { score: 0, sources: [], conflicts: false };
  }

  const maxSimilarity = Math.max(...sources.map(s => s.similarity || 0));
  const conflicts = prices.length > 1 && new Set(prices).size > 1;

  return { score: maxSimilarity, sources, conflicts };
}

function detectMissingFields(
  intent: string | null,
  products: Product[],
  docs: KnowledgeDoc[]
): string[] {
  const missing: string[] = [];

  if (intent === "price" || intent === "availability") {
    const hasPrice = products.some(p => p.price !== null && p.price !== undefined);
    if (!hasPrice) missing.push("price");

    const hasStock = products.some(p => p.inStock !== null && p.inStock !== undefined);
    if (!hasStock) missing.push("availability");
  }

  if (intent === "shipping") {
    const hasDelivery = docs.some(d => d.category === "shipping") || 
                        products.some(p => p.deliveryInfo);
    if (!hasDelivery) missing.push("delivery_terms");
  }

  return missing;
}

interface PenaltyContext {
  intent: string | null;
  sources: UsedSource[];
  conflicts: boolean;
  hasStaleData: boolean;
  lowSimilarity: boolean;
  missingFields: string[];
  selfCheckScore: number;
  settings: DecisionSettings;
}

function applyPenalties(ctx: PenaltyContext): { penalties: Penalty[]; forceEscalate: boolean } {
  const { intent, sources, conflicts, hasStaleData, lowSimilarity, missingFields, selfCheckScore, settings } = ctx;
  const penalties: Penalty[] = [];
  let forceEscalate = false;

  const intentsForceHandoff = (settings.intentsForceHandoff || []) as string[];
  if (intent && intentsForceHandoff.includes(intent)) {
    penalties.push(PENALTY_CODES.INTENT_FORCE_HANDOFF);
    forceEscalate = true;
  }

  if (sources.length === 0) {
    penalties.push(PENALTY_CODES.NO_SOURCES);
  }

  if (missingFields.includes("price") && intent === "price") {
    penalties.push(PENALTY_CODES.PRICE_NOT_FOUND);
  }

  if (missingFields.includes("availability") && intent === "availability") {
    penalties.push(PENALTY_CODES.AVAILABILITY_NOT_FOUND);
  }

  if (conflicts) {
    penalties.push(PENALTY_CODES.CONFLICTING_SOURCES);
  }

  if (hasStaleData) {
    penalties.push(PENALTY_CODES.STALE_DATA);
    forceEscalate = true;
  }

  if (lowSimilarity && sources.length > 0) {
    penalties.push(PENALTY_CODES.LOW_SIMILARITY);
  }

  if (selfCheckScore < 0.5) {
    penalties.push(PENALTY_CODES.SELF_CHECK_LOW);
  }

  return { penalties, forceEscalate };
}

function calculateFinalConfidence(
  similarityScore: number,
  intentScore: number,
  selfCheckScore: number,
  penalties: Penalty[]
): ConfidenceBreakdown {
  const penaltySum = penalties.reduce((sum, p) => sum + Math.abs(p.value), 0);
  
  const raw = CONFIDENCE_WEIGHTS.similarity * similarityScore +
              CONFIDENCE_WEIGHTS.intent * intentScore +
              CONFIDENCE_WEIGHTS.selfCheck * selfCheckScore;
  
  const total = clamp(raw - penaltySum, 0, 1);

  return {
    total,
    similarity: similarityScore,
    intent: intentScore,
    selfCheck: selfCheckScore,
  };
}

function makeDecision(
  confidence: number,
  forceEscalate: boolean,
  settings: DecisionSettings
): DecisionType {
  if (forceEscalate) {
    return "ESCALATE";
  }

  if (confidence >= settings.tAuto) {
    return "AUTO_SEND";
  }

  if (confidence >= settings.tEscalate) {
    return "NEED_APPROVAL";
  }

  return "ESCALATE";
}

function generateExplanations(
  decision: DecisionType,
  confidence: ConfidenceBreakdown,
  penalties: Penalty[],
  intent: string | null,
  sources: UsedSource[],
  settings: DecisionSettings
): string[] {
  const explanations: string[] = [];

  if (sources.length > 0 && confidence.similarity > 0.7) {
    explanations.push("Высокая схожесть с документами базы знаний");
  }

  for (const penalty of penalties) {
    explanations.push(penalty.message);
  }

  if (decision === "AUTO_SEND") {
    explanations.push(`Уверенность ${(confidence.total * 100).toFixed(0)}% выше порога автоотправки`);
  } else if (decision === "NEED_APPROVAL") {
    explanations.push(`Уверенность ${(confidence.total * 100).toFixed(0)}% требует проверки оператором`);
  } else if (decision === "ESCALATE") {
    explanations.push(`Уверенность ${(confidence.total * 100).toFixed(0)}% ниже порога — передача оператору`);
  }

  return explanations;
}

interface SelfCheckResult {
  score: number;
  needHandoff: boolean;
  reasons: string[];
  missingFields: string[];
}

async function performSelfCheck(
  customerMessage: string,
  draftReply: string,
  sources: UsedSource[],
  tenant: Tenant
): Promise<SelfCheckResult> {
  try {
    const sourcesContext = sources.slice(0, 3).map(s => 
      `[${s.type}] ${s.title}: ${s.quote}`
    ).join("\n");

    const prompt = `You are a quality checker for customer support responses.

Customer question: "${customerMessage}"
Draft response: "${draftReply}"
Sources used:
${sourcesContext || "No sources"}

Evaluate the draft response and return JSON:
{
  "self_check_score": 0.0-1.0 (how confident you are this is a good response),
  "need_handoff": true|false (should this go to a human?),
  "reasons": ["reason1", "reason2"] (reasons for your score or handoff decision),
  "missing_fields": ["price", "availability"] (if any critical info is missing)
}

Rules:
- Score LOW if the response makes up information not in sources
- Score LOW if critical data (price, availability, delivery) is missing from sources but mentioned in response
- Score HIGH if response accurately uses source information
- need_handoff=true if the question requires human judgment (discounts, complaints, special requests)`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      max_completion_tokens: 256,
    });

    const content = response.choices[0]?.message?.content || "{}";
    const parsed = JSON.parse(content);

    return {
      score: clamp(parsed.self_check_score || 0.6, 0, 1),
      needHandoff: parsed.need_handoff ?? false,
      reasons: Array.isArray(parsed.reasons) ? parsed.reasons : [],
      missingFields: parsed.missing_fields || [],
    };
  } catch (error) {
    console.error("Self-check failed:", error);
    return { score: 0.6, needHandoff: false, reasons: [], missingFields: [] };
  }
}

export async function generateWithDecisionEngine(
  context: GenerationContext
): Promise<DecisionResult> {
  const settings = await storage.getDecisionSettings(context.tenantId) || DEFAULT_SETTINGS;
  
  const decisionEngineEnabled = await featureFlagService.isEnabled("DECISION_ENGINE_ENABLED", context.tenantId);
  const autosendEnabled = await featureFlagService.isEnabled("AI_AUTOSEND_ENABLED", context.tenantId);
  const ragEnabled = await featureFlagService.isEnabled("RAG_ENABLED", context.tenantId);

  let ragResult: RetrievalResult | null = null;
  let contextParts: string[] = [];

  if (ragEnabled) {
    try {
      ragResult = await retrieveContext(context.customerMessage, {
        tenantId: context.tenantId,
      });
      
      if (ragResult.chunks.length > 0) {
        const ragContext = formatContextForPrompt(ragResult);
        if (ragContext) {
          contextParts.push(ragContext);
        }
      }
    } catch (error) {
      console.warn("[Decision Engine] RAG retrieval failed, using fallback:", error);
      ragResult = null;
    }
  }

  if (!ragResult || ragResult.chunks.length === 0) {
    if (context.products.length > 0) {
      contextParts.push("Products:\n" + context.products.map((p) => 
        `- ${p.name}: ${p.price} ${p.currency}, ${p.inStock ? "in stock" : "out of stock"}`
      ).join("\n"));
    }
    if (context.docs.length > 0) {
      contextParts.push("Knowledge Base:\n" + context.docs.map((d) => 
        `- ${d.title}: ${d.content.slice(0, 200)}`
      ).join("\n"));
    }
  }

  const customerContextBlock = buildCustomerContextBlock(context.customerMemory);

  let fewShotBlock = "";
  const fewShotEnabled = await featureFlagService.isEnabled("FEW_SHOT_LEARNING", context.tenantId);
  if (fewShotEnabled) {
    try {
      const fewShotConfig: Partial<FewShotConfig> = {
        maxExamples: 5,
        maxTokens: 1500,
        minConfidence: 0.7,
      };
      const examples = await selectFewShotExamples(context.tenantId, fewShotConfig);
      if (examples.length > 0) {
        const { promptBlock } = buildFewShotPromptBlock(examples, fewShotConfig.maxTokens || 1500);
        fewShotBlock = promptBlock;
      }
    } catch (error) {
      console.warn("[Decision Engine] Few-shot learning failed, continuing without examples:", error);
    }
  }

  const systemPrompt = `You are a professional sales consultant for "${context.tenant.name}".
Communication style: ${context.tenant.tone === "formal" ? "formal, polite" : "friendly, casual"}, address as "${context.tenant.addressStyle === "vy" ? "Vy (formal)" : "ty (informal)"}", language: ${context.tenant.language}.

IMPORTANT RULES:
1. NEVER make up prices, availability, or delivery times. Only use facts from the provided context.
2. If information is not available, ask clarifying questions.
3. Be concise and helpful.
4. If the customer asks for a discount: ${context.tenant.allowDiscounts ? `You can offer up to ${context.tenant.maxDiscountPercent}% discount.` : "Politely explain that discounts are not available."}

${contextParts.length > 0 ? "CONTEXT:\n" + contextParts.join("\n\n") : "No specific product/knowledge context available."}
${customerContextBlock ? "\n" + customerContextBlock : ""}
${fewShotBlock ? "\n" + fewShotBlock : ""}

Respond ONLY with a JSON object in this exact format:
{
  "reply_text": "Your response to the customer",
  "intent": "price|availability|shipping|return|discount|complaint|other|vehicle_id_request|gearbox_tag_request|gearbox_tag_retry",
  "intent_probability": 0.0-1.0,
  "questions_to_ask": ["optional questions if info is missing"]
}
Use vehicle_id_request when asking for VIN/FRAME; gearbox_tag_request when asking for gearbox nameplate photo; gearbox_tag_retry when asking to resend unreadable photo.`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: systemPrompt },
      ...context.conversationHistory,
    ],
    response_format: { type: "json_object" },
    max_completion_tokens: 1024,
  });

  const responseContent = response.choices[0]?.message?.content || "{}";
  let parsed;
  try {
    parsed = JSON.parse(responseContent);
  } catch {
    parsed = {
      reply_text: "Прошу прощения, не удалось сформировать ответ. Пожалуйста, попробуйте еще раз.",
      intent: "other",
      intent_probability: 0.5,
      questions_to_ask: [],
    };
  }

  const intent: string = INTENT_TYPES.includes(parsed.intent)
    ? (parsed.intent as IntentType)
    : (VEHICLE_LOOKUP_INTENTS.includes(parsed.intent as any) ? parsed.intent : "other");
  const intentScore = clamp(parsed.intent_probability || 0.6, 0, 1);

  let similarityScore: number;
  let sources: UsedSource[];
  let conflicts: boolean;
  let hasStaleData = false;
  let lowSimilarity = false;

  if (ragResult && ragResult.chunks.length > 0) {
    const ragScores = calculateSimilarityScoreFromRetrieval(ragResult);
    similarityScore = ragScores.score;
    sources = ragScores.sources;
    conflicts = ragScores.conflicts;
    hasStaleData = ragScores.hasStaleData;
    lowSimilarity = ragScores.lowSimilarity;
  } else {
    const fallbackScores = calculateSimilarityScoreFallback(context.products, context.docs);
    similarityScore = fallbackScores.score;
    sources = fallbackScores.sources;
    conflicts = fallbackScores.conflicts;
  }

  const selfCheckResult = await performSelfCheck(context.customerMessage, parsed.reply_text, sources, context.tenant);
  const { score: selfCheckScore, needHandoff: selfCheckNeedHandoff, reasons: selfCheckReasons, missingFields: selfCheckMissing } = selfCheckResult;

  const detectedMissing = detectMissingFields(intent, context.products, context.docs);
  const allMissingFields = Array.from(new Set([...detectedMissing, ...selfCheckMissing]));

  const { penalties, forceEscalate } = applyPenalties({
    intent,
    sources,
    conflicts,
    hasStaleData,
    lowSimilarity,
    missingFields: allMissingFields,
    selfCheckScore,
    settings,
  });

  const confidence = calculateFinalConfidence(similarityScore, intentScore, selfCheckScore, penalties);

  let decision: DecisionType;
  let autosendEligible = false;
  let autosendBlockReason: "FLAG_OFF" | "SETTING_OFF" | "INTENT_NOT_ALLOWED" | undefined;
  let policyBlockedIntent: string | null = null;

  if (!decisionEngineEnabled) {
    // Kill switch: decision engine disabled, always need approval
    decision = "NEED_APPROVAL";
    autosendEligible = false;
  } else {
    decision = makeDecision(confidence.total, forceEscalate || selfCheckNeedHandoff, settings);

    // Check training policy: alwaysEscalateIntents prevents AUTO_SEND
    const trainingPolicy = await storage.getAiTrainingPolicy(context.tenantId);
    if (trainingPolicy?.alwaysEscalateIntents && 
        intent && 
        trainingPolicy.alwaysEscalateIntents.includes(intent) && 
        decision === "AUTO_SEND") {
      decision = "NEED_APPROVAL";
      policyBlockedIntent = intent;
    }

    // Use shared function for triple lock autosend eligibility
    const autosendCheck = checkAutosendEligibility(decision, intent, autosendEnabled, settings);
    autosendEligible = autosendCheck.eligible;
    autosendBlockReason = autosendCheck.blockReason;

    // Vehicle lookup intents: allow autosend only when self-check does not require handoff
    if (autosendEligible && intent && VEHICLE_LOOKUP_INTENTS.includes(intent as any) && selfCheckNeedHandoff) {
      autosendEligible = false;
    }

    // Guardrail: never autosend vehicle-lookup intents if reply contains price/offer
    if (autosendEligible && intent && VEHICLE_LOOKUP_INTENTS.includes(intent as any) && replyContainsPriceOrOffer(parsed.reply_text)) {
      autosendEligible = false;
    }
  }

  const explanations = generateExplanations(decision, confidence, penalties, intent, sources, settings);

  // Add policy block explanation
  if (policyBlockedIntent) {
    explanations.unshift(`Интент "${policyBlockedIntent}" настроен для обязательной проверки оператором`);
  }

  // Add self-check reasons to explanations if handoff needed
  if (selfCheckNeedHandoff && selfCheckReasons.length > 0) {
    explanations.push(`Self-check: ${selfCheckReasons.join("; ")}`);
  }

  // Add autosend block reason to explanations
  if (decision === "AUTO_SEND" && !autosendEligible && autosendBlockReason) {
    const blockMessages: Record<string, string> = {
      FLAG_OFF: "Автоотправка отключена глобально (feature flag)",
      SETTING_OFF: "Автоотправка отключена в настройках",
      INTENT_NOT_ALLOWED: `Интент "${intent}" не разрешён для автоотправки`,
    };
    explanations.unshift(`Рекомендуется автоответ, но: ${blockMessages[autosendBlockReason]}`);
  }

  return {
    replyText: parsed.reply_text,
    intent,
    confidence,
    decision,
    explanations,
    penalties,
    missingFields: allMissingFields,
    usedSources: sources,
    needsApproval: decision !== "AUTO_SEND" || !autosendEligible,
    needsHandoff: decision === "ESCALATE",
    autosendEligible,
    autosendBlockReason,
    selfCheckNeedHandoff,
    selfCheckReasons,
  };
}

export const decisionEngine = {
  generateWithDecisionEngine,
  DEFAULT_SETTINGS,
};

// Named export for easier imports
export { DEFAULT_SETTINGS };

// Export helper functions for unit testing
// These are internal functions that should be tested directly
export const _testing = {
  calculateFinalConfidence,
  makeDecision,
  applyPenalties,
  detectMissingFields,
  generateExplanations,
  CONFIDENCE_WEIGHTS,
  checkAutosendEligibility,
  replyContainsPriceOrOffer,
  convertRetrievalToSources,
  STALE_DATA_THRESHOLD_MS,
  LOW_SIMILARITY_THRESHOLD,
};

// Guardrail: block autosend for vehicle-lookup intents when reply looks like price/offer
function replyContainsPriceOrOffer(replyText: string): boolean {
  const lower = replyText.toLowerCase().trim();
  const priceWords = ["цена", "стоимость", "стоит", "руб", "рублей", "₽", "eur", "usd", "€", "$", "скидк", "%"];
  if (priceWords.some((w) => lower.includes(w))) return true;
  // Numbers that look like prices (e.g. 15 000, 15000, 1.500)
  if (/\d[\d\s.,]*\s*(руб|р\.|eur|usd|€|\$|₽)/i.test(replyText)) return true;
  if (/\d+%/.test(replyText)) return true;
  return false;
}

// Internal function for autosend eligibility check - used by both production and tests
function checkAutosendEligibility(
  decision: DecisionType,
  intent: string | null,
  autosendFeatureFlag: boolean,
  settings: DecisionSettings
): { eligible: boolean; blockReason?: "FLAG_OFF" | "SETTING_OFF" | "INTENT_NOT_ALLOWED" } {
  if (decision !== "AUTO_SEND") {
    return { eligible: false };
  }
  if (!autosendFeatureFlag) {
    return { eligible: false, blockReason: "FLAG_OFF" };
  }
  if (!settings.autosendAllowed) {
    return { eligible: false, blockReason: "SETTING_OFF" };
  }
  const intentsAllowed = (settings.intentsAutosendAllowed || []) as string[];
  if (intent && !intentsAllowed.includes(intent)) {
    return { eligible: false, blockReason: "INTENT_NOT_ALLOWED" };
  }
  return { eligible: true };
}
