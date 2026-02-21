import { Worker, Job } from "bullmq";
import IORedis from "ioredis";
import { VehicleLookupJobData } from "../services/vehicle-lookup-queue";
import { getRedisConnectionConfig } from "../services/message-queue";
import {
  lookupByVehicleId,
  PODZAMENU_NOT_FOUND,
  PodzamenuLookupError,
} from "../services/podzamenu-lookup-client";
import type { GearboxInfo } from "../services/podzamenu-lookup-client";
import { fillGearboxTemplate } from "../services/gearbox-templates";
import { detectGearboxType } from "../services/price-sources/types";
import { storage } from "../storage";

const QUEUE_NAME = "vehicle_lookup_queue";

const DUPLICATE_SUGGESTION_WINDOW_MS = 2 * 60 * 1000; // 2 minutes

function computeLookupConfidence(gearbox: GearboxInfo, evidence: Record<string, unknown>): number {
  let c = 0.5;
  const hasOem = gearbox.oemStatus === "FOUND" && !!gearbox.oem;
  const isModelOnly = gearbox.oemStatus === "MODEL_ONLY" && !!gearbox.model;
  if (hasOem) c += 0.3;
  if (isModelOnly) c += 0.2;
  if (evidence.sourceSelected === "podzamenu") c += 0.1;
  if (Array.isArray(gearbox.oemCandidates) && gearbox.oemCandidates.length > 0) c += 0.1;
  if (gearbox.oemStatus === "NOT_AVAILABLE") c -= 0.2;
  if (!hasOem && !isModelOnly) c -= 0.2;
  return Math.max(0, Math.min(1, c));
}

function buildResultSuggestionText(
  templates: { gearboxLookupFound: string; gearboxLookupModelOnly: string; gearboxTagRequest: string; gearboxLookupFallback: string; gearboxNoVin: string },
  gearbox: GearboxInfo,
  evidence: Record<string, unknown>,
  lookupConfidence: number
): string {
  const source = (evidence.sourceSelected as string) ?? (evidence.source as string) ?? "";
  const oem = gearbox.oem ?? "";
  const model = gearbox.model ?? "";
  const factoryCode = gearbox.factoryCode ?? "";
  const params = { oem, model, source, factoryCode };

  if (gearbox.oemStatus === "MODEL_ONLY") {
    return fillGearboxTemplate(templates.gearboxLookupModelOnly, params);
  }
  if (lookupConfidence >= 0.8) {
    return fillGearboxTemplate(templates.gearboxLookupFound, params);
  }
  if (lookupConfidence >= 0.5) {
    return fillGearboxTemplate(templates.gearboxLookupModelOnly, params);
  }
  return fillGearboxTemplate(templates.gearboxTagRequest, params);
}

async function createResultSuggestionIfNeeded(params: {
  tenantId: string;
  conversationId: string;
  messageId?: string;
  gearbox: GearboxInfo;
  evidence: Record<string, unknown>;
  lookupConfidence: number;
}): Promise<void> {
  const { tenantId, conversationId, messageId, gearbox, evidence, lookupConfidence } = params;
  const templates = await storage.getTenantTemplates(tenantId);
  const suggestedReply = buildResultSuggestionText(templates, gearbox, evidence, lookupConfidence);

  const intent =
    (gearbox.oemStatus === "FOUND" && gearbox.oem) || gearbox.oemStatus === "MODEL_ONLY"
      ? "other"
      : "gearbox_tag_request";

  const recentSuggestions = await storage.getSuggestionsByConversation(conversationId);
  const cutoff = new Date(Date.now() - DUPLICATE_SUGGESTION_WINDOW_MS);
  const hasDuplicate = recentSuggestions
    .slice(0, 5)
    .some((s) => s.suggestedReply === suggestedReply && s.createdAt >= cutoff);
  if (hasDuplicate) {
    console.log(`[VehicleLookupWorker] Skipping duplicate suggestion for conversation ${conversationId}`);
    return;
  }

  const suggestion = await storage.createAiSuggestion({
    conversationId,
    messageId: messageId ?? null,
    suggestedReply,
    intent,
    confidence: lookupConfidence,
    needsApproval: true,
    needsHandoff: false,
    questionsToAsk: [],
    usedSources: [],
    status: "pending",
    decision: "NEED_APPROVAL",
    autosendEligible: false,
  });

  try {
    const { realtimeService } = await import("../services/websocket-server");
    realtimeService.broadcastNewSuggestion(tenantId, conversationId, suggestion.id);
  } catch {
    // Skip broadcast if import fails (e.g. circular deps, worker runs separately)
  }

  console.log(`[VehicleLookupWorker] Created result suggestion ${suggestion.id} for conversation ${conversationId}`);
}

async function getLastCustomerMessageText(conversationId: string): Promise<string | null> {
  const msgs = await storage.getMessagesByConversation(conversationId);
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === "customer" && msgs[i].content) {
      return msgs[i].content;
    }
  }
  return null;
}

async function tryFallbackPriceLookup(params: {
  tenantId: string;
  conversationId: string;
  messageId?: string;
  gearbox: GearboxInfo;
  vehicleMeta?: { make?: string; model?: string; year?: number };
}): Promise<void> {
  const { tenantId, conversationId, messageId, gearbox, vehicleMeta } = params;

  const lastMessage = await getLastCustomerMessageText(conversationId);
  if (!lastMessage) {
    console.log("[VehicleLookupWorker] No customer message found for fallback gearbox type detection");
    return;
  }

  const gearboxType = detectGearboxType(lastMessage);
  if (gearboxType === "unknown") {
    console.log("[VehicleLookupWorker] Gearbox type not detected in customer message, skipping fallback price lookup");
    return;
  }

  const make = vehicleMeta?.make ?? null;
  const model = vehicleMeta?.model ?? null;

  const templates = await storage.getTenantTemplates(tenantId);
  const fallbackText = fillGearboxTemplate(templates.gearboxLookupFallback, {
    gearboxType: gearboxType.toUpperCase(),
    make: make ?? "",
    model: model ?? "",
  });

  const recentSuggestions = await storage.getSuggestionsByConversation(conversationId);
  const cutoff = new Date(Date.now() - DUPLICATE_SUGGESTION_WINDOW_MS);
  const hasDuplicate = recentSuggestions
    .slice(0, 5)
    .some((s) => s.suggestedReply === fallbackText && s.createdAt >= cutoff);

  if (!hasDuplicate) {
    const suggestion = await storage.createAiSuggestion({
      conversationId,
      messageId: messageId ?? null,
      suggestedReply: fallbackText,
      intent: "gearbox_fallback_search",
      confidence: 0.5,
      needsApproval: true,
      needsHandoff: false,
      questionsToAsk: [],
      usedSources: [],
      status: "pending",
      decision: "NEED_APPROVAL",
      autosendEligible: false,
    });

    try {
      const { realtimeService } = await import("../services/websocket-server");
      realtimeService.broadcastNewSuggestion(tenantId, conversationId, suggestion.id);
    } catch {
      // Skip broadcast if import fails
    }
    console.log(`[VehicleLookupWorker] Created fallback suggestion ${suggestion.id}`);
  }

  const { enqueuePriceLookup } = await import("../services/price-lookup-queue");
  await enqueuePriceLookup({
    tenantId,
    conversationId,
    oem: null,
    searchFallback: {
      make,
      model,
      gearboxType,
      gearboxModel: gearbox.model ?? null,
    },
  });
  console.log(`[VehicleLookupWorker] Fallback price lookup started: ${gearboxType} for ${make ?? "?"} ${model ?? "?"}`);
}

async function processVehicleLookup(job: Job<VehicleLookupJobData>): Promise<void> {
  const { caseId, tenantId, conversationId, idType, normalizedValue } = job.data;

  console.log(`[VehicleLookupWorker] Processing job: ${job.id}, caseId: ${caseId}`);

  const caseRow = await storage.getVehicleLookupCaseById(caseId);
  if (!caseRow) {
    throw new Error(`Case not found: ${caseId}`);
  }

  await storage.updateVehicleLookupCaseStatus(caseId, { status: "RUNNING" });

  try {
    const lookupResult = await lookupByVehicleId({ idType, value: normalizedValue });
    const { gearbox } = lookupResult;

    const hasOem = gearbox.oemStatus === "FOUND" && gearbox.oem;
    const hasModel = !!gearbox.model;

    if (!hasOem && !hasModel) {
      await storage.updateVehicleLookupCaseStatus(caseId, {
        status: "FAILED",
        error: "PARSE_FAILED",
      });
      console.error(`[VehicleLookupWorker] Case failed (parse): ${caseId} - no OEM nor model`);
      return;
    }

    const lookupConfidence = computeLookupConfidence(gearbox, lookupResult.evidence as Record<string, unknown>);
    const result = {
      vehicleMeta: lookupResult.vehicleMeta,
      gearbox: lookupResult.gearbox,
      evidence: lookupResult.evidence,
      lookupConfidence,
    } as Record<string, unknown>;

    const lookupKey = normalizedValue;
    const evidenceSource = (lookupResult.evidence?.sourceSelected as string) ?? (lookupResult.evidence?.source as string) ?? "podzamenu";
    await storage.upsertVehicleLookupCache({
      lookupKey,
      idType,
      rawValue: caseRow.rawValue,
      normalizedValue,
      result,
      source: evidenceSource,
    });

    const cacheRow = await storage.getVehicleLookupCacheByKey(lookupKey);
    if (cacheRow) {
      await storage.linkCaseToCache(caseId, cacheRow.id);
    }

    await storage.updateVehicleLookupCaseStatus(caseId, {
      status: "COMPLETED",
      verificationStatus: "NEED_TAG_OPTIONAL",
    });

    const factoryTag = gearbox.factoryCode ? `, factoryCode: ${gearbox.factoryCode}` : "";
    const logValue = hasOem
      ? `gearbox OEM ${gearbox.oem}${factoryTag}`
      : `gearbox model ${gearbox.model} (OEM not available)${factoryTag}`;
    const src = (lookupResult.evidence?.sourceSelected as string) ?? (lookupResult.evidence?.source as string) ?? "podzamenu";
    console.log(`[VehicleLookupWorker] Case completed: ${caseId} - ${logValue} [${src}], lookup confidence: ${lookupConfidence.toFixed(2)}`);

    await createResultSuggestionIfNeeded({
      tenantId,
      conversationId,
      messageId: caseRow.messageId ?? undefined,
      gearbox,
      evidence: lookupResult.evidence as Record<string, unknown>,
      lookupConfidence,
    });

    const isModelOnly = gearbox.oemStatus === "MODEL_ONLY" && !!gearbox.model;

    if (isModelOnly) {
      const vehicleMeta = lookupResult.vehicleMeta as { make?: string; model?: string; year?: number } | undefined;
      const lastMessage = await getLastCustomerMessageText(conversationId);
      const gearboxType = lastMessage ? detectGearboxType(lastMessage) : "unknown" as const;

      const { enqueuePriceLookup } = await import("../services/price-lookup-queue");
      await enqueuePriceLookup({
        tenantId,
        conversationId,
        oem: null,
        searchFallback: {
          make: vehicleMeta?.make ?? null,
          model: vehicleMeta?.model ?? null,
          gearboxType,
          gearboxModel: gearbox.model ?? null,
        },
        isModelOnly: true,
      });
      console.log(`[VehicleLookupWorker] Auto-started price lookup (VW Group MODEL_ONLY, model: ${gearbox.model}).`);
    } else if (lookupConfidence >= 0.85 && gearbox.oemStatus === "FOUND" && gearbox.oem) {
      const { enqueuePriceLookup } = await import("../services/price-lookup-queue");
      await enqueuePriceLookup({ tenantId, conversationId, oem: gearbox.oem });
      console.log("[VehicleLookupWorker] Auto-started price lookup (high confidence OEM).");
    } else if (gearbox.oemStatus !== "FOUND" || !gearbox.oem) {
      await tryFallbackPriceLookup({
        tenantId,
        conversationId,
        messageId: caseRow.messageId ?? undefined,
        gearbox,
        vehicleMeta: lookupResult.vehicleMeta as { make?: string; model?: string; year?: number } | undefined,
      });
    }
  } catch (error) {
    if (error instanceof PodzamenuLookupError && error.code === PODZAMENU_NOT_FOUND) {
      console.log(`[VehicleLookupWorker] Case not found: ${caseId}`);
      await storage.updateVehicleLookupCaseStatus(caseId, {
        status: "FAILED",
        error: "NOT_FOUND",
      });
      return;
    }

    const message = error instanceof Error ? error.message : String(error);
    console.error(`[VehicleLookupWorker] Case failed: ${caseId}`, message);
    await storage.updateVehicleLookupCaseStatus(caseId, {
      status: "FAILED",
      error: message,
    });
    throw error;
  }
}

export function createVehicleLookupWorker(connectionConfig: IORedis): Worker<VehicleLookupJobData> {
  const worker = new Worker<VehicleLookupJobData>(
    QUEUE_NAME,
    async (job) => {
      await processVehicleLookup(job);
    },
    {
      connection: connectionConfig,
      concurrency: 1,
    }
  );

  worker.on("completed", (job) => {
    console.log(`[VehicleLookupWorker] Job completed: ${job.id}`);
  });

  worker.on("failed", (job, error) => {
    console.error(`[VehicleLookupWorker] Job failed: ${job?.id}`, error?.message);
  });

  worker.on("error", (error) => {
    console.error("[VehicleLookupWorker] Worker error:", error);
  });

  console.log(`[VehicleLookupWorker] Worker started for queue: ${QUEUE_NAME}`);
  return worker;
}

export async function startVehicleLookupWorker(): Promise<Worker<VehicleLookupJobData> | null> {
  const config = getRedisConnectionConfig();
  if (!config) {
    console.warn("[VehicleLookupWorker] REDIS_URL not configured, worker not started");
    return null;
  }

  try {
    return createVehicleLookupWorker(config);
  } catch (error) {
    console.error("[VehicleLookupWorker] Failed to start worker:", error);
    return null;
  }
}

const isMain = process.argv[1]?.includes("vehicle-lookup.worker");
if (isMain) {
  startVehicleLookupWorker()
    .then((worker) => {
      if (worker) {
        console.log("[VehicleLookupWorker] Process running...");
        process.on("SIGTERM", async () => {
          console.log("[VehicleLookupWorker] Shutting down...");
          await worker.close();
          process.exit(0);
        });
      } else {
        console.error("[VehicleLookupWorker] Failed to start worker");
        process.exit(1);
      }
    })
    .catch((error) => {
      console.error("[VehicleLookupWorker] Startup error:", error);
      process.exit(1);
    });
}
