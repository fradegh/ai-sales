import { storage } from "../storage";
import type { ParsedIncomingMessage } from "./channel-adapter";
import { getMergedGearboxTemplates } from "./gearbox-templates";
import { realtimeService } from "./websocket-server";

const VIN_CHARS = "A-HJ-NPR-Z0-9"; // VIN excludes I, O, Q
const VIN_REGEX = new RegExp(`[${VIN_CHARS}]{17}`, "gi");
const VIN_INCOMPLETE_REGEX = new RegExp(`[${VIN_CHARS}]{16}(?![${VIN_CHARS}])`, "gi");
const FRAME_REGEX = /[A-Z0-9]{3,}\s*-\s*[A-Z0-9]{3,}/gi;

export type VehicleIdDetection =
  | { idType: "VIN"; rawValue: string; normalizedValue: string }
  | { idType: "VIN"; rawValue: string; normalizedValue: string; isIncompleteVin: true }
  | { idType: "FRAME"; rawValue: string; normalizedValue: string };

export function detectVehicleIdFromText(text: string): VehicleIdDetection | null {
  if (!text || typeof text !== "string") return null;
  const trimmed = text.trim();
  if (!trimmed.length) return null;

  const candidates: { index: number; det: VehicleIdDetection }[] = [];

  // VIN 17 (full)
  let m: RegExpExecArray | null;
  VIN_REGEX.lastIndex = 0;
  while ((m = VIN_REGEX.exec(trimmed)) !== null) {
    const raw = m[0];
    const normalized = raw.replace(/\s/g, "").toUpperCase();
    if (normalized.length === 17) {
      candidates.push({ index: m.index, det: { idType: "VIN", rawValue: raw, normalizedValue: normalized } });
    }
  }

  // VIN 16 (incomplete)
  VIN_INCOMPLETE_REGEX.lastIndex = 0;
  while ((m = VIN_INCOMPLETE_REGEX.exec(trimmed)) !== null) {
    const raw = m[0];
    const normalized = raw.replace(/\s/g, "").toUpperCase();
    if (normalized.length === 16) {
      candidates.push({
        index: m.index,
        det: { idType: "VIN", rawValue: raw, normalizedValue: normalized, isIncompleteVin: true },
      });
    }
  }

  // FRAME (pattern with dash)
  FRAME_REGEX.lastIndex = 0;
  while ((m = FRAME_REGEX.exec(trimmed)) !== null) {
    const raw = m[0].trim();
    const normalized = raw.replace(/\s/g, "").toUpperCase();
    candidates.push({ index: m.index, det: { idType: "FRAME", rawValue: raw, normalizedValue: normalized } });
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.index - b.index);
  return candidates[0].det;
}

const INCOMPLETE_VIN_REPLY =
  "Похоже VIN содержит 16 символов. Проверьте, пожалуйста — обычно VIN состоит из 17 символов. Пришлите полный VIN или номер кузова (FRAME).";

export async function handleIncomingMessage(
  tenantId: string,
  parsed: ParsedIncomingMessage
): Promise<{ conversationId: string; messageId: string; isNew: boolean }> {
  const tenant = await storage.getTenant(tenantId) || await storage.getDefaultTenant();
  if (!tenant) {
    throw new Error("Tenant not found");
  }

  // Find existing customer by (tenantId, channel, externalUserId)
  let customer = await storage.getCustomerByExternalId(tenant.id, parsed.channel, parsed.externalUserId);
  
  if (!customer) {
    const customerName = (parsed.metadata?.pushName as string) ||
                         (parsed.metadata?.firstName as string) ||
                         (parsed.metadata?.contactName as string) ||
                         `User ${parsed.externalUserId.slice(-4)}`;
    
    const isLid = parsed.metadata?.isLid === true;
    const remoteJid = (parsed.metadata?.remoteJid as string) || parsed.externalConversationId;
    let customerPhone = (parsed.metadata?.phone as string) || "";
    
    customer = await storage.createCustomer({
      tenantId: tenant.id,
      channel: parsed.channel,
      externalId: parsed.externalUserId,
      name: customerName,
      phone: customerPhone,
      metadata: { remoteJid },
    });
    console.log(`[InboundHandler] Created new customer: ${customer.id} for ${parsed.channel}:${parsed.externalUserId}${isLid ? " (LID contact)" : ""}`);
  }

  const allConversations = await storage.getConversationsByTenant(tenant.id);
  const existingConv = allConversations.find(c => 
    c.customerId === customer!.id && 
    (c.status === "active" || c.status === "pending")
  );
  let isNew = false;
  let conversationId: string;
  let unreadCount: number;

  if (existingConv) {
    conversationId = existingConv.id;
    unreadCount = existingConv.unreadCount || 0;
  } else {
    isNew = true;
    const messageTime = parsed.timestamp ? new Date(parsed.timestamp) : new Date();
    const newConv = await storage.createConversation({
      tenantId: tenant.id,
      customerId: customer.id,
      status: "active",
      mode: "learning",
      unreadCount: 1,
      lastMessageAt: messageTime,
      createdAt: messageTime,
    });
    conversationId = newConv.id;
    unreadCount = 0;
    console.log(`[InboundHandler] Created new conversation: ${newConv.id}`);
  }

  const existingMessages = await storage.getMessagesByConversation(conversationId);
  const existingMessage = existingMessages.find(m => 
    m.metadata && (m.metadata as any).externalId === parsed.externalMessageId
  );
  
  if (existingMessage) {
    console.log(`[InboundHandler] Duplicate message ignored: ${parsed.externalMessageId}`);
    return { conversationId, messageId: existingMessage.id, isNew: false };
  }

  const message = await storage.createMessage({
    conversationId,
    role: "customer",
    content: parsed.text,
    metadata: {
      externalId: parsed.externalMessageId,
      channel: parsed.channel,
      ...parsed.metadata,
    },
    createdAt: parsed.timestamp ? new Date(parsed.timestamp) : undefined,
  });

  console.log(`[InboundHandler] Saved message ${message.id} to conversation ${conversationId}`);

  await storage.updateConversation(conversationId, {
    unreadCount: unreadCount + 1,
  });

  realtimeService.broadcastNewMessage(tenant.id, message, conversationId);
  
  if (isNew) {
    const conversationWithCustomer = await storage.getConversationWithCustomer(conversationId);
    if (conversationWithCustomer) {
      realtimeService.broadcastNewConversation(tenant.id, conversationWithCustomer);
    }
  } else {
    realtimeService.broadcastConversationUpdate(tenant.id, {
      id: conversationId,
      unreadCount: unreadCount + 1,
    });
  }

  return { conversationId, messageId: message.id, isNew };
}

export async function triggerAiSuggestion(conversationId: string): Promise<void> {
  try {
    const conversation = await storage.getConversationDetail(conversationId);
    if (!conversation) {
      console.warn(`[InboundHandler] Conversation not found for AI: ${conversationId}`);
      return;
    }

    const tenant = await storage.getTenant(conversation.tenantId) || await storage.getDefaultTenant();
    if (!tenant) {
      console.warn(`[InboundHandler] Tenant not found for AI suggestion`);
      return;
    }

    const lastCustomerMessage = conversation.messages
      .filter((m) => m.role === "customer")
      .pop();

    if (!lastCustomerMessage) {
      console.warn(`[InboundHandler] No customer message found for AI`);
      return;
    }

    const pendingSuggestion = await storage.getPendingSuggestionByConversation(conversationId);
    if (pendingSuggestion) {
      console.log(`[InboundHandler] Already has pending suggestion for ${conversationId}`);
      return;
    }

    const relevantDocs = await storage.searchKnowledgeDocs(tenant.id, lastCustomerMessage.content);
    const relevantProducts = await storage.searchProducts(tenant.id, lastCustomerMessage.content);

    const customerMemory = await storage.getCustomerMemory(tenant.id, conversation.customer.id);

    const conversationHistory = conversation.messages.slice(-6).map((m) => ({
      role: (m.role === "customer" ? "user" : "assistant") as "user" | "assistant",
      content: m.content,
    }));

    const { generateWithDecisionEngine } = await import("./decision-engine");
    const decisionResult = await generateWithDecisionEngine({
      conversationId,
      tenantId: tenant.id,
      tenant,
      customerMessage: lastCustomerMessage.content,
      conversationHistory,
      products: relevantProducts,
      docs: relevantDocs,
      customerMemory,
    });

    const suggestion = await storage.createAiSuggestion({
      conversationId,
      messageId: lastCustomerMessage.id,
      suggestedReply: decisionResult.replyText,
      intent: decisionResult.intent,
      confidence: decisionResult.confidence.total,
      needsApproval: decisionResult.needsApproval,
      needsHandoff: decisionResult.needsHandoff,
      questionsToAsk: [],
      usedSources: decisionResult.usedSources,
      status: "pending",
      similarityScore: decisionResult.confidence.similarity,
      intentScore: decisionResult.confidence.intent,
      selfCheckScore: decisionResult.confidence.selfCheck,
      decision: decisionResult.decision,
      explanations: decisionResult.explanations,
      penalties: decisionResult.penalties,
      sourceConflicts: decisionResult.usedSources.length > 0,
    });

    console.log(`[InboundHandler] Created AI suggestion ${suggestion.id} with decision: ${decisionResult.decision}`);

    // Notify frontend about new suggestion via WebSocket
    realtimeService.broadcastNewSuggestion(tenant.id, conversationId, suggestion.id);

    // Increment frequent topic for customer memory
    if (decisionResult.intent && decisionResult.intent !== "other") {
      try {
        await storage.incrementFrequentTopic(tenant.id, conversation.customer.id, decisionResult.intent);
        console.log(`[InboundHandler] Incremented topic "${decisionResult.intent}" for customer ${conversation.customer.id}`);
      } catch (error) {
        console.error(`[InboundHandler] Failed to increment topic:`, error);
      }
    }

    // Trigger summary generation based on message count
    try {
      const { shouldTriggerSummaryByMessageCount, generateCustomerSummary } = await import("./customer-summary-service");
      const shouldTrigger = await shouldTriggerSummaryByMessageCount(tenant.id, conversation.customer.id);
      if (shouldTrigger) {
        generateCustomerSummary(tenant.id, conversation.customer.id, "message_count").catch(err => {
          console.error("[InboundHandler] Summary generation failed:", err);
        });
      }
    } catch (error) {
      console.error("[InboundHandler] Summary trigger check failed:", error);
    }

    if (decisionResult.decision === "AUTO_SEND") {
      console.log(`[InboundHandler] AUTO_SEND triggered for conversation ${conversationId}`);
    }
  } catch (error) {
    console.error(`[InboundHandler] AI suggestion error:`, error);
  }
}

export async function processIncomingMessageFull(
  tenantId: string,
  parsed: ParsedIncomingMessage
): Promise<void> {
  try {
    const result = await handleIncomingMessage(tenantId, parsed);
    const text = (parsed.text || "").trim();

    const vehicleDet = detectVehicleIdFromText(text);

    if (vehicleDet && "isIncompleteVin" in vehicleDet && vehicleDet.isIncompleteVin) {
      const conversation = await storage.getConversationDetail(result.conversationId);
      const tenant = conversation ? await storage.getTenant(conversation.tenantId) ?? await storage.getDefaultTenant() : null;
      if (conversation && tenant) {
        const suggestion = await storage.createAiSuggestion({
          conversationId: result.conversationId,
          messageId: result.messageId,
          suggestedReply: INCOMPLETE_VIN_REPLY,
          intent: "vehicle_id_request",
          confidence: 1,
          needsApproval: true,
          needsHandoff: false,
          questionsToAsk: [],
          usedSources: [],
          status: "pending",
        });
        realtimeService.broadcastNewSuggestion(tenant.id, result.conversationId, suggestion.id);
        console.log(`[InboundHandler] Incomplete VIN detected, created vehicle_id_request suggestion for ${result.conversationId}`);
      }
      return;
    }

    if (vehicleDet && !("isIncompleteVin" in vehicleDet && vehicleDet.isIncompleteVin)) {
      const activeCase = await storage.findActiveVehicleLookupCase(tenantId, result.conversationId, vehicleDet.normalizedValue);
      if (activeCase) {
        console.log("[InboundHandler] Skipped duplicate vehicle lookup case");
      } else {
        const row = await storage.createVehicleLookupCase({
          tenantId,
          conversationId: result.conversationId,
          messageId: result.messageId,
          idType: vehicleDet.idType,
          rawValue: vehicleDet.rawValue,
          normalizedValue: vehicleDet.normalizedValue,
          status: "PENDING",
          verificationStatus: "NONE",
        });
        const { enqueueVehicleLookup } = await import("./vehicle-lookup-queue");
        await enqueueVehicleLookup({
          caseId: row.id,
          tenantId,
          conversationId: result.conversationId,
          idType: vehicleDet.idType,
          normalizedValue: vehicleDet.normalizedValue,
        });
        console.log(`[InboundHandler] Vehicle ID detected (${vehicleDet.idType}), created case ${row.id} and enqueued lookup`);

        const tenant = await storage.getTenant(tenantId) ?? await storage.getDefaultTenant();
        if (tenant) {
          const templates = getMergedGearboxTemplates(tenant);
          const suggestion = await storage.createAiSuggestion({
            conversationId: result.conversationId,
            messageId: result.messageId,
            suggestedReply: templates.gearboxTagRequest,
            intent: "gearbox_tag_request",
            confidence: 1,
            needsApproval: true,
            needsHandoff: false,
            questionsToAsk: [],
            usedSources: [],
            status: "pending",
          });
          realtimeService.broadcastNewSuggestion(tenant.id, result.conversationId, suggestion.id);
          console.log(`[InboundHandler] Created gearbox_tag_request suggestion for vehicle lookup case ${row.id}`);
        }
      }
    }

    await triggerAiSuggestion(result.conversationId);
  } catch (error) {
    console.error(`[InboundHandler] Error processing message:`, error);
  }
}
