import { Worker, Job } from "bullmq";
import { PriceLookupJobData } from "../services/price-lookup-queue";
import { getRedisConnectionConfig } from "../services/message-queue";
import { storage } from "../storage";

const QUEUE_NAME = "price_lookup_queue";

const SNAPSHOT_MAX_AGE_MINUTES = 60;

function formatPriceSuggestion(
  oem: string,
  minPrice: number,
  maxPrice: number,
  avgPrice: number,
  source: string,
  updatedAt: Date
): string {
  const timeStr = updatedAt.toLocaleString("ru-RU", { timeZone: "Europe/Moscow", hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });
  return `Найдены ориентировочные цены по OEM ${oem}: ${minPrice}–${maxPrice} (средняя ${avgPrice}).\nОбновлено: ${timeStr}. Источник: ${source}.`;
}

async function processPriceLookup(job: Job<PriceLookupJobData>): Promise<void> {
  const { tenantId, conversationId, oem } = job.data;

  console.log(`[PriceLookupWorker] Running price lookup for OEM ${oem}`);

  let minPrice: number;
  let maxPrice: number;
  let avgPrice: number;
  let source: string;
  let snapshotTime: Date;

  const cached = await storage.getLatestPriceSnapshot(tenantId, oem, SNAPSHOT_MAX_AGE_MINUTES);
  if (cached) {
    console.log(`[PriceLookupWorker] Using cached snapshot ${cached.id} for OEM ${oem}`);
    minPrice = cached.minPrice ?? 0;
    maxPrice = cached.maxPrice ?? 0;
    avgPrice = cached.avgPrice ?? 0;
    source = cached.source;
    snapshotTime = cached.createdAt;
  } else {
    minPrice = 1000;
    maxPrice = 1500;
    avgPrice = 1200;
    source = "mock";

    const snapshot = await storage.createPriceSnapshot({
      tenantId,
      oem,
      source,
      minPrice,
      maxPrice,
      avgPrice,
      raw: { minPrice, maxPrice, avgPrice, source },
    });
    snapshotTime = snapshot.createdAt;
    console.log(`[PriceLookupWorker] Created snapshot ${snapshot.id} for OEM ${oem}`);
  }

  const suggestedReply = formatPriceSuggestion(oem, minPrice, maxPrice, avgPrice, source, snapshotTime);

  const suggestion = await storage.createAiSuggestion({
    conversationId,
    messageId: null,
    suggestedReply,
    intent: "price",
    confidence: 0.8,
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
    // Skip broadcast if import fails (e.g. worker runs separately)
  }

  console.log(`[PriceLookupWorker] Created price suggestion ${suggestion.id} for conversation ${conversationId}`);
}

export function createPriceLookupWorker(connectionConfig: {
  host: string;
  port: number;
}): Worker<PriceLookupJobData> {
  const worker = new Worker<PriceLookupJobData>(
    QUEUE_NAME,
    async (job) => {
      await processPriceLookup(job);
    },
    {
      connection: connectionConfig,
      concurrency: 1,
    }
  );

  worker.on("completed", (job) => {
    console.log(`[PriceLookupWorker] Job completed: ${job.id}`);
  });

  worker.on("failed", (job, error) => {
    console.error(`[PriceLookupWorker] Job failed: ${job?.id}`, error?.message);
  });

  worker.on("error", (error) => {
    console.error("[PriceLookupWorker] Worker error:", error);
  });

  console.log(`[PriceLookupWorker] Worker started for queue: ${QUEUE_NAME}`);
  return worker;
}

export async function startPriceLookupWorker(): Promise<Worker<PriceLookupJobData> | null> {
  const config = getRedisConnectionConfig();
  if (!config) {
    console.warn("[PriceLookupWorker] REDIS_URL not configured, worker not started");
    return null;
  }

  try {
    return createPriceLookupWorker(config);
  } catch (error) {
    console.error("[PriceLookupWorker] Failed to start worker:", error);
    return null;
  }
}

const isMain = process.argv[1]?.includes("price-lookup.worker");
if (isMain) {
  startPriceLookupWorker()
    .then((worker) => {
      if (worker) {
        console.log("[PriceLookupWorker] Process running...");
        process.on("SIGTERM", async () => {
          console.log("[PriceLookupWorker] Shutting down...");
          await worker.close();
          process.exit(0);
        });
      } else {
        console.error("[PriceLookupWorker] Failed to start worker");
        process.exit(1);
      }
    })
    .catch((error) => {
      console.error("[PriceLookupWorker] Startup error:", error);
      process.exit(1);
    });
}
