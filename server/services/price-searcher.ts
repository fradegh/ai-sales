import { openai } from "./decision-engine";

export interface PriceSearchListing {
  title: string;
  price: number;
  mileage: number | null;
  url?: string;
  site: string;
  isUsed: boolean;
}

export interface PriceSearchResult {
  minPrice: number;
  maxPrice: number;
  avgPrice: number;
  mileageMin: number | null;
  mileageMax: number | null;
  currency: "RUB";
  source: "openai_web_search" | "not_found";
  listingsCount: number;
  listings: PriceSearchListing[];
  searchQuery: string;
  filteredOutCount: number;
}

type Origin = "japan" | "europe" | "korea" | "usa" | "unknown";

// Keywords that indicate NEW / rebuilt units — must be excluded
const EXCLUDE_KEYWORDS = [
  "новая",
  "новый",
  "новое",
  "восстановл",
  "remanufactured",
  "rebuilt",
];

// Keywords that indicate used / contract units — prioritized
const PREFER_KEYWORDS = [
  "контрактная",
  "б/у",
  "с разборки",
  "из японии",
  "из европы",
  "японская",
  "европейская",
  "kontraktnaya",
];

function buildPrimaryQuery(
  oem: string,
  modelName: string | null,
  origin: Origin
): string {
  const namePart = modelName ? `${oem} ${modelName}` : oem;
  switch (origin) {
    case "japan":
      return `контрактная коробка передач ${namePart} из Японии цена`;
    case "europe":
      return `контрактная коробка передач ${namePart} из Европы цена`;
    default:
      return `контрактная коробка передач ${namePart} б/у цена`;
  }
}

function buildFallbackQuery(oem: string, modelName: string | null): string {
  return `КПП ${modelName ?? oem} контрактная б/у с разборки цена рублей`;
}

function isExcluded(text: string): boolean {
  const lower = text.toLowerCase();
  return EXCLUDE_KEYWORDS.some((kw) => lower.includes(kw));
}

function isPreferred(text: string): boolean {
  const lower = text.toLowerCase();
  return PREFER_KEYWORDS.some((kw) => lower.includes(kw));
}

function parsePriceFromText(text: string): number | null {
  const match = text.match(/(\d[\d\s]*)\s*(?:₽|руб\.?|RUB)/i);
  if (!match) return null;
  const num = parseInt(match[1].replace(/\s/g, ""), 10);
  if (!Number.isFinite(num) || num < 1_000 || num > 15_000_000) return null;
  // Handle USD → RUB conversion (~90 rate)
  return num;
}

function parseMileageFromText(text: string): number | null {
  const match = text.match(/(\d[\d\s]*)\s*(?:км|km)/i);
  if (!match) return null;
  const num = parseInt(match[1].replace(/\s/g, ""), 10);
  if (!Number.isFinite(num) || num < 0 || num > 500_000) return null;
  return num;
}

function extractSiteName(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}

function removeOutliers(prices: number[]): number[] {
  if (prices.length < 3) return prices;
  prices.sort((a, b) => a - b);
  const median = prices[Math.floor(prices.length / 2)];
  return prices.filter((p) => p <= median * 3);
}

interface ParsedListing {
  title: string;
  price: number;
  mileage: number | null;
  url: string;
  site: string;
  isUsed: boolean;
}

function parseListingsFromResponse(content: string): ParsedListing[] {
  const listings: ParsedListing[] = [];

  // Try to find JSON array in the response first
  const jsonMatch = content.match(/\[\s*\{[\s\S]*?\}\s*\]/);
  if (jsonMatch) {
    try {
      const arr = JSON.parse(jsonMatch[0]) as Array<Record<string, unknown>>;
      for (const item of arr) {
        const price = typeof item.price === "number" ? item.price : parsePriceFromText(String(item.price ?? ""));
        if (!price) continue;
        listings.push({
          title: String(item.title ?? ""),
          price,
          mileage: typeof item.mileage === "number" ? item.mileage : parseMileageFromText(String(item.mileage ?? "")),
          url: String(item.url ?? ""),
          site: String(item.site ?? extractSiteName(String(item.url ?? ""))),
          isUsed: true,
        });
      }
      if (listings.length > 0) return listings;
    } catch {
      // Fall through to text parsing
    }
  }

  // Text parsing fallback — scan each line/paragraph for price data
  const lines = content.split(/\n+/);
  for (const line of lines) {
    if (isExcluded(line)) continue;
    const price = parsePriceFromText(line);
    if (!price) continue;
    const mileage = parseMileageFromText(line);
    const urlMatch = line.match(/https?:\/\/[^\s)]+/);
    const url = urlMatch ? urlMatch[0] : "";
    listings.push({
      title: line.slice(0, 200).trim(),
      price,
      mileage,
      url,
      site: extractSiteName(url),
      isUsed: isPreferred(line),
    });
  }

  return listings;
}

/**
 * Searches for used/contract transmission prices via OpenAI Responses API
 * (gpt-4.1 with web_search tool).
 * Returns source: 'not_found' if < 2 valid listings found after filtering.
 */
export async function searchUsedTransmissionPrice(
  oem: string,
  modelName: string | null,
  origin: Origin
): Promise<PriceSearchResult> {
  const primaryQuery = buildPrimaryQuery(oem, modelName, origin);
  const fallbackQuery = buildFallbackQuery(oem, modelName);

  const notFoundResult: PriceSearchResult = {
    minPrice: 0,
    maxPrice: 0,
    avgPrice: 0,
    mileageMin: null,
    mileageMax: null,
    currency: "RUB",
    source: "not_found",
    listingsCount: 0,
    listings: [],
    searchQuery: primaryQuery,
    filteredOutCount: 0,
  };

  const runSearch = async (query: string): Promise<ParsedListing[]> => {
    console.log(`[PriceSearcher] Web search query: "${query}"`);
    // Embed output format instructions directly in the input — search models don't use system prompts
    const input =
      query +
      "\n\nНайди актуальные объявления о продаже б/у и контрактных КПП на avito.ru, drom.ru, autopiter.ru, exist.ru. " +
      "Верни ТОЛЬКО JSON-массив без пояснений: " +
      '[{"title":"...","price":число_рублей,"mileage":число_км_или_null,"url":"...","site":"...","isUsed":true}]. ' +
      "ИСКЛЮЧАЙ новые и восстановленные коробки. ВКЛЮЧАЙ только б/у, контрактные, с разборки.";
    try {
      const response = await (openai as any).responses.create({
        model: "gpt-4.1",
        tools: [{ type: "web_search" }],
        input,
      });

      const content: string = response.output_text ?? "";

      return parseListingsFromResponse(content);
    } catch (err: any) {
      console.warn(`[PriceSearcher] OpenAI web search failed: ${err.message}`);
      return [];
    }
  };

  // Primary search
  let rawListings = await runSearch(primaryQuery);
  let usedQuery = primaryQuery;

  // Filter: exclude new/rebuilt
  let filteredOut = 0;
  let listings = rawListings.filter((l) => {
    if (isExcluded(l.title)) {
      filteredOut++;
      return false;
    }
    return true;
  });

  // Fallback search if < 2 valid listings
  if (listings.length < 2) {
    console.log(`[PriceSearcher] Primary search yielded ${listings.length} listings, trying fallback`);
    rawListings = await runSearch(fallbackQuery);
    usedQuery = fallbackQuery;
    filteredOut = 0;
    listings = rawListings.filter((l) => {
      if (isExcluded(l.title)) {
        filteredOut++;
        return false;
      }
      return true;
    });
  }

  if (listings.length < 2) {
    console.log(`[PriceSearcher] Not enough listings found for OEM "${oem}" (${listings.length} valid)`);
    return { ...notFoundResult, searchQuery: usedQuery, filteredOutCount: filteredOut };
  }

  // Remove outliers > 3x median
  const validPrices = removeOutliers(listings.map((l) => l.price));
  const validListings = listings.filter((l) => validPrices.includes(l.price));

  if (validListings.length < 2) {
    return { ...notFoundResult, searchQuery: usedQuery, filteredOutCount: filteredOut };
  }

  const minPrice = Math.min(...validPrices);
  const maxPrice = Math.max(...validPrices);
  const avgPrice = Math.round(validPrices.reduce((a, b) => a + b, 0) / validPrices.length);

  const mileages = validListings.map((l) => l.mileage).filter((m): m is number => m !== null);
  const mileageMin = mileages.length > 0 ? Math.min(...mileages) : null;
  const mileageMax = mileages.length > 0 ? Math.max(...mileages) : null;

  console.log(
    `[PriceSearcher] Found ${validListings.length} valid listings for OEM "${oem}": ` +
      `${minPrice}–${maxPrice} RUB, avg ${avgPrice} RUB`
  );

  return {
    minPrice,
    maxPrice,
    avgPrice,
    mileageMin,
    mileageMax,
    currency: "RUB",
    source: "openai_web_search",
    listingsCount: validListings.length,
    listings: validListings,
    searchQuery: usedQuery,
    filteredOutCount: filteredOut,
  };
}
