import { storage } from "../storage";
import type { AiTrainingSample } from "@shared/schema";
import { sanitizeString } from "../utils/sanitizer";

export interface FewShotConfig {
  maxExamples: number;
  maxTokens: number;
  minConfidence: number;
  preferredIntent?: string;
  preferredCategory?: string;
}

export const DEFAULT_FEW_SHOT_CONFIG: FewShotConfig = {
  maxExamples: 5,
  maxTokens: 1500,
  minConfidence: 0.7,
};

export interface FewShotExample {
  userMessage: string;
  assistantReply: string;
  intent: string | null;
  category: string | null;
  score: number;
}

export interface FewShotResult {
  examples: FewShotExample[];
  promptBlock: string;
  totalTokens: number;
  groupedByIntent: Map<string, FewShotExample[]>;
}

const TOKENS_PER_CHAR = 0.25;

function estimateTokens(text: string): number {
  return Math.ceil(text.length * TOKENS_PER_CHAR);
}

function extractCategoryFromSample(sample: AiTrainingSample): string | null {
  return null;
}

function scoreExample(
  sample: AiTrainingSample,
  config: FewShotConfig
): number {
  let score = 1.0;
  
  if (sample.outcome === "APPROVED") {
    score += 0.2;
  } else if (sample.outcome === "EDITED") {
    score += 0.1;
  }
  
  if (config.preferredIntent && sample.intent === config.preferredIntent) {
    score += 0.5;
  }
  
  const category = extractCategoryFromSample(sample);
  if (config.preferredCategory && category === config.preferredCategory) {
    score += 0.3;
  }
  
  if (sample.decision === "AUTO_SEND") {
    score += 0.15;
  }
  
  return score;
}

function isHighConfidence(sample: AiTrainingSample, minConfidence: number): boolean {
  if (sample.decision === "AUTO_SEND") {
    return true;
  }
  if (sample.decision === "NEED_APPROVAL" && sample.outcome === "APPROVED") {
    return true;
  }
  if (sample.outcome === "EDITED") {
    return true;
  }
  return false;
}

export async function selectFewShotExamples(
  tenantId: string,
  config: Partial<FewShotConfig> = {}
): Promise<FewShotExample[]> {
  const fullConfig: FewShotConfig = { ...DEFAULT_FEW_SHOT_CONFIG, ...config };
  
  const allSamples = await storage.getAiTrainingSamplesByTenant(tenantId);
  const policy = await storage.getAiTrainingPolicy(tenantId);
  const disabledIntents = policy?.disabledLearningIntents ?? [];
  
  const eligibleSamples = allSamples.filter(sample => {
    if (sample.outcome !== "APPROVED" && sample.outcome !== "EDITED") {
      return false;
    }
    
    if (!sample.finalAnswer || sample.finalAnswer.trim() === "") {
      return false;
    }
    
    if (!isHighConfidence(sample, fullConfig.minConfidence)) {
      return false;
    }
    
    if (disabledIntents.length > 0 && sample.intent && disabledIntents.includes(sample.intent)) {
      return false;
    }
    
    return true;
  });
  
  const scoredSamples = eligibleSamples.map(sample => ({
    sample,
    score: scoreExample(sample, fullConfig),
  }));
  
  scoredSamples.sort((a, b) => b.score - a.score);
  
  const selected = scoredSamples.slice(0, fullConfig.maxExamples);
  
  return selected.map(({ sample, score }) => ({
    userMessage: sample.userMessage,
    assistantReply: sample.finalAnswer!,
    intent: sample.intent,
    category: extractCategoryFromSample(sample),
    score,
  }));
}

export function groupByIntent(examples: FewShotExample[]): Map<string, FewShotExample[]> {
  const grouped = new Map<string, FewShotExample[]>();
  
  for (const example of examples) {
    const key = example.intent || "other";
    const existing = grouped.get(key) || [];
    existing.push(example);
    grouped.set(key, existing);
  }
  
  return grouped;
}

export function buildFewShotPromptBlock(
  examples: FewShotExample[],
  maxTokens: number
): { promptBlock: string; totalTokens: number; usedExamples: FewShotExample[] } {
  if (examples.length === 0) {
    return { promptBlock: "", totalTokens: 0, usedExamples: [] };
  }
  
  const header = "\n## Примеры успешных ответов:\n\n";
  let promptBlock = header;
  let totalTokens = estimateTokens(header);
  const usedExamples: FewShotExample[] = [];
  
  for (const example of examples) {
    const safeUserMessage = sanitizeString(example.userMessage);
    const safeAssistantReply = sanitizeString(example.assistantReply);
    const exampleBlock = `Клиент: ${safeUserMessage}\nОператор: ${safeAssistantReply}\n\n`;
    const exampleTokens = estimateTokens(exampleBlock);
    
    if (totalTokens + exampleTokens > maxTokens) {
      break;
    }
    
    promptBlock += exampleBlock;
    totalTokens += exampleTokens;
    usedExamples.push(example);
  }
  
  if (usedExamples.length === 0) {
    return { promptBlock: "", totalTokens: 0, usedExamples: [] };
  }
  
  return { promptBlock, totalTokens, usedExamples };
}

export async function buildFewShotBlock(
  tenantId: string,
  config: Partial<FewShotConfig> = {}
): Promise<FewShotResult> {
  const fullConfig: FewShotConfig = { ...DEFAULT_FEW_SHOT_CONFIG, ...config };
  
  const examples = await selectFewShotExamples(tenantId, fullConfig);
  
  const groupedByIntent = groupByIntent(examples);
  
  const { promptBlock, totalTokens, usedExamples } = buildFewShotPromptBlock(
    examples,
    fullConfig.maxTokens
  );
  
  return {
    examples: usedExamples,
    promptBlock,
    totalTokens,
    groupedByIntent,
  };
}

export const fewShotBuilder = {
  selectFewShotExamples,
  groupByIntent,
  buildFewShotPromptBlock,
  buildFewShotBlock,
  estimateTokens,
  DEFAULT_FEW_SHOT_CONFIG,
};
