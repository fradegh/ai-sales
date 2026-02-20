import { Worker, Job } from "bullmq";
import { PriceLookupJobData, SearchFallback } from "../services/price-lookup-queue";
import { getRedisConnectionConfig } from "../services/message-queue";
import { storage } from "../storage";
import type { PriceSource, PriceResult, GearboxType } from "../services/price-sources/types";
import { detectGearboxType, GEARBOX_TYPE_SEARCH_TERM } from "../services/price-sources/types";
import { AvitoSource } from "../services/price-sources/avito-source";
import { DromSource } from "../services/price-sources/drom-source";
import { WebSource } from "../services/price-sources/web-source";
import { MockSource } from "../services/price-sources/mock-source";

const QUEUE_NAME = "price_lookup_queue";

const SNAPSHOT_MAX_AGE_MINUTES = 60;

const externalSources: PriceSource[] = [
  new AvitoSource(),
  new DromSource(),
  new WebSource(),
];
const mockSource = new MockSource();

interface PriceSettings {
  marginPct?: number;
  roundTo?: number;
  priceNote?: string;
  showMarketPrice?: boolean;
}

function applyCommercialLogic(
  priceResult: PriceResult,
  settings: PriceSettings
): { salePrice: number; marginPct: number; priceNote: string | null } {
  const marginPct = settings.marginPct ?? -25;
  const roundTo = settings.roundTo ?? 100;
  const salePrice =
    Math.round((priceResult.avgPrice * (1 + marginPct / 100)) / roundTo) * roundTo;

  return {
    salePrice: Math.max(salePrice, 0),
    marginPct,
    priceNote: settings.priceNote ?? null,
  };
}

function buildSearchQuery(oem: string | null, fallback?: SearchFallback): string {
  if (oem) return oem;
  if (!fallback) return "";
  const parts: string[] = [];
  if (fallback.gearboxModel) parts.push(fallback.gearboxModel);
  if (fallback.make) parts.push(fallback.make);
  if (fallback.model) parts.push(fallback.model);
  return parts.join(" ");
}

function buildSearchKey(oem: string | null, fallback?: SearchFallback): string {
  if (oem) return oem;
  if (!fallback) return "";
  const parts = [
    fallback.gearboxModel ?? "",
    fallback.make ?? "",
    fallback.model ?? "",
    fallback.gearboxType,
  ].filter(Boolean);
  return parts.join("_");
}

function formatPriceSuggestion(
  label: string,
  salePrice: number,
  marketAvg: number,
  source: string,
  updatedAt: Date,
  priceNote: string | null,
  showMarketPrice: boolean,
  isFallback: boolean,
  isModelOnly: boolean = false
): string {
  const timeStr = updatedAt.toLocaleString("ru-RU", {
    timeZone: "Europe/Moscow",
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "2-digit",
  });

  let text: string;
  if (isModelOnly) {
    text = `Цена по модели ${label}: ${salePrice} ₽`;
  } else if (isFallback) {
    text = `Найдены варианты ${label}: ${salePrice} ₽`;
  } else {
    text = `Цена по OEM ${label}: ${salePrice} ₽`;
  }
  if (showMarketPrice && marketAvg !== salePrice) {
    text += ` (рыночная ≈${marketAvg} ₽)`;
  }
  if (isFallback && !isModelOnly) {
    text += `\n⚠️ Без точного OEM — цена приблизительная.`;
  }
  if (priceNote) {
    text += `\n${priceNote}`;
  }
  text += `\nОбновлено: ${timeStr}. Источник: ${source}.`;
  return text;
}

async function autoSaveToInternal(
  tenantId: string,
  oem: string | null,
  priceResult: PriceResult
): Promise<void> {
  if (!oem) return;
  if (priceResult.source === "mock" || priceResult.source === "internal") return;

  let saved = 0;
  for (const listing of priceResult.listings) {
    try {
      await storage.upsertInternalPrice({
        tenantId,
        oem,
        price: listing.price,
        currency: "RUB",
        condition: listing.condition,
        supplier: `${priceResult.source}:${listing.seller}`,
      });
      saved++;
    } catch (err: any) {
      console.warn(`[PriceLookupWorker] Failed to save internal price: ${err.message}`);
    }
  }
  if (saved > 0) {
    console.log(
      `[PriceLookupWorker] Auto-saved ${saved} prices to internal_prices (source: ${priceResult.source})`
    );
  }
}

async function fetchFromExternalSources(
  searchQuery: string,
  gearboxType?: GearboxType
): Promise<PriceResult | null> {
  for (const src of externalSources) {
    console.log(`[PriceLookupWorker] Trying source: ${src.name} for query "${searchQuery}" (gearbox: ${gearboxType ?? "auto"})`);
    try {
      const result = await src.fetchPrices(searchQuery, gearboxType);
      if (result) {
        console.log(`[PriceLookupWorker] Source ${src.name} returned ${result.listings.length} listings`);
        return result;
      }
    } catch (error: any) {
      console.warn(`[PriceLookupWorker] Source ${src.name} threw: ${error.message}`);
    }
  }
  return null;
}

async function processPriceLookup(job: Job<PriceLookupJobData>): Promise<void> {
  const { tenantId, conversationId, oem, searchFallback, isModelOnly } = job.data;
  const isFallbackMode = !oem && !!searchFallback && !isModelOnly;
  const isModelOnlyMode = !!isModelOnly && !!searchFallback?.gearboxModel;

  const searchQuery = buildSearchQuery(oem, searchFallback);
  const searchKey = isModelOnlyMode
    ? `model:${searchFallback!.gearboxModel}`
    : buildSearchKey(oem, searchFallback);
  const gearboxType: GearboxType | undefined = searchFallback?.gearboxType
    ?? (oem ? undefined : undefined);

  const displayLabel = isModelOnlyMode
    ? `КПП ${searchFallback!.gearboxModel} ${searchFallback!.make ?? ""} ${searchFallback!.model ?? ""}`.trim()
    : isFallbackMode
      ? `${(searchFallback!.gearboxType ?? "").toUpperCase()} ${searchFallback!.make ?? ""} ${searchFallback!.model ?? ""}`.trim()
      : oem!;

  const modeLabel = isModelOnlyMode ? "MODEL_ONLY" : isFallbackMode ? "FALLBACK" : "OEM";
  console.log(`[PriceLookupWorker] Running price lookup: ${modeLabel} mode, query="${searchQuery}", key="${searchKey}"`);

  const tenant = await storage.getTenant(tenantId);
  const templates = (tenant?.templates ?? {}) as Record<string, unknown>;
  const priceSettings = (templates.priceSettings ?? {}) as PriceSettings;

  let priceResult: PriceResult;

  // Step 1: Check cached snapshot by searchKey
  const cached = await storage.getLatestPriceSnapshot(tenantId, searchKey, SNAPSHOT_MAX_AGE_MINUTES);
  if (cached) {
    console.log(`[PriceLookupWorker] Using cached snapshot ${cached.id} for key "${searchKey}" (source: ${cached.source})`);

    const salePrice = cached.avgPrice ?? 0;
    const marketAvg = cached.marketAvgPrice ?? cached.avgPrice ?? 0;
    const suggestedReply = formatPriceSuggestion(
      displayLabel,
      salePrice,
      marketAvg,
      cached.source,
      cached.createdAt,
      cached.priceNote ?? null,
      priceSettings.showMarketPrice ?? false,
      isFallbackMode,
      isModelOnlyMode
    );

    const suggestion = await storage.createAiSuggestion({
      conversationId,
      messageId: null,
      suggestedReply,
      intent: "price",
      confidence: isModelOnlyMode ? 0.8 : isFallbackMode ? 0.6 : 0.8,
      needsApproval: true,
      needsHandoff: false,
      questionsToAsk: [],
      usedSources: [],
      status: "pending",
      decision: "NEED_APPROVAL",
      autosendEligible: false,
    });

    broadcastSuggestion(tenantId, conversationId, suggestion.id);
    console.log(`[PriceLookupWorker] Created price suggestion ${suggestion.id} (cached)`);
    return;
  }

  // Step 2: Check internal_prices (only when we have an OEM)
  if (oem) {
    const internalRows = await storage.getInternalPricesByOem(tenantId, oem);
    if (internalRows.length > 0) {
      const prices = internalRows.map((r) => r.price);
      priceResult = {
        minPrice: Math.min(...prices),
        maxPrice: Math.max(...prices),
        avgPrice: Math.round(prices.reduce((a, b) => a + b, 0) / prices.length),
        currency: "RUB",
        listings: internalRows.map((r) => ({
          title: `Internal: ${oem}`,
          price: r.price,
          condition: (r.condition as "contract" | "used" | "new") ?? "contract",
          seller: r.supplier ?? "internal",
          url: "",
        })),
        source: "internal",
      };
      console.log(`[PriceLookupWorker] Found ${internalRows.length} internal price(s) for OEM ${oem}`);
    } else {
      priceResult = await fetchOrMock(searchQuery, oem, tenantId, gearboxType);
    }
  } else {
    // Fallback: skip internal_prices (no OEM), go straight to external
    priceResult = await fetchOrMock(searchQuery, oem, tenantId, gearboxType);
  }

  const { salePrice, marginPct, priceNote } = applyCommercialLogic(priceResult, priceSettings);

  const rawPayload =
    priceResult.source === "mock"
      ? [{ minPrice: priceResult.minPrice, maxPrice: priceResult.maxPrice, avgPrice: priceResult.avgPrice }]
      : priceResult.listings.map((l) => ({
          title: l.title,
          price: l.price,
          condition: l.condition,
          seller: l.seller,
          url: l.url,
        }));

  const snapshot = await storage.createPriceSnapshot({
    tenantId,
    oem: oem ?? "",
    source: priceResult.source,
    minPrice: salePrice,
    maxPrice: salePrice,
    avgPrice: salePrice,
    marketMinPrice: priceResult.minPrice,
    marketMaxPrice: priceResult.maxPrice,
    marketAvgPrice: priceResult.avgPrice,
    salePrice,
    marginPct,
    priceNote,
    searchKey,
    raw: rawPayload,
  });

  console.log(
    `[PriceLookupWorker] Created snapshot ${snapshot.id} for key "${searchKey}" ` +
      `(source: ${priceResult.source}, market avg: ${priceResult.avgPrice}, sale: ${salePrice}${isModelOnlyMode ? ", MODEL_ONLY" : isFallbackMode ? ", FALLBACK" : ""})`
  );

  const suggestedReply = formatPriceSuggestion(
    displayLabel,
    salePrice,
    priceResult.avgPrice,
    priceResult.source,
    snapshot.createdAt,
    priceNote,
    priceSettings.showMarketPrice ?? false,
    isFallbackMode,
    isModelOnlyMode
  );

  const suggestion = await storage.createAiSuggestion({
    conversationId,
    messageId: null,
    suggestedReply,
    intent: "price",
    confidence: isModelOnlyMode ? 0.8 : isFallbackMode ? 0.6 : 0.8,
    needsApproval: true,
    needsHandoff: false,
    questionsToAsk: [],
    usedSources: [],
    status: "pending",
    decision: "NEED_APPROVAL",
    autosendEligible: false,
  });

  broadcastSuggestion(tenantId, conversationId, suggestion.id);
  console.log(`[PriceLookupWorker] Created price suggestion ${suggestion.id} for conversation ${conversationId}`);
}

async function fetchOrMock(
  searchQuery: string,
  oem: string | null,
  tenantId: string,
  gearboxType?: GearboxType
): Promise<PriceResult> {
  const externalResult = await fetchFromExternalSources(searchQuery, gearboxType);
  if (externalResult) {
    await autoSaveToInternal(tenantId, oem, externalResult);
    return externalResult;
  }
  console.log(`[PriceLookupWorker] All sources exhausted for query "${searchQuery}", using mock`);
  return mockSource.fetchPrices(searchQuery, gearboxType);
}

function broadcastSuggestion(tenantId: string, conversationId: string, suggestionId: string) {
  import("../services/websocket-server")
    .then(({ realtimeService }) => {
      realtimeService.broadcastNewSuggestion(tenantId, conversationId, suggestionId);
    })
    .catch(() => {
      // Skip broadcast if import fails (worker runs separately)
    });
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
