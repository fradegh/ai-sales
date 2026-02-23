import { openai } from "./decision-engine";
import type { VehicleContext } from "./transmission-identifier";

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

// Keywords that indicate defective / damaged units — must be excluded.
// "с разборки" alone is kept (it is a standard contractual term);
// only "с разборки под запчасти" (damaged donor) is excluded.
const DEFECT_KEYWORDS = [
  "дефект",
  "неисправн",
  "не работ",
  "пинает",
  "толчок",
  "рывок",
  "на запчасти",
  "под восстановление",
  "требует ремонта",
  "не едет",
  "нет задней",
  "нет передач",
  "горит check",
  "в ремонт",
  "разбор",
  "с разборки под запчасти",
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

// Strip parenthetical suffix from gearbox codes: "DES(5A)" → "DES", "01M(ABC)" → "01M"
function stripParenthetical(code: string): string {
  const idx = code.indexOf("(");
  return idx !== -1 ? code.slice(0, idx).trim() : code.trim();
}

// Prefer GPT-identified market codes (e.g. W5MBB) over raw OEM catalog numbers
// (e.g. 2500A230). OEM codes with 4+ consecutive digits are internal catalog refs
// that produce poor search results.
function resolveSearchTerm(oem: string, modelName: string | null): string {
  if (!modelName) return oem;
  if (/\d{4,}/.test(modelName)) return oem; // looks like an OEM/catalog number
  return modelName;
}

function buildPrimaryQuery(
  oem: string,
  modelName: string | null,
  origin: Origin,
  gearboxLabel: string,
  make?: string | null,
  vehicleDesc?: string | null
): string {
  const searchTerm = resolveSearchTerm(oem, modelName);
  // Append OEM code only when it differs from searchTerm to avoid duplication
  const oemSuffix = searchTerm !== oem ? ` ${oem}` : '';
  if (vehicleDesc) {
    switch (origin) {
      case "japan":
        return `контрактная ${gearboxLabel} ${searchTerm}${oemSuffix} ${vehicleDesc} б/у из Японии`;
      case "europe":
        return `контрактная ${gearboxLabel} ${searchTerm}${oemSuffix} ${vehicleDesc} б/у из Европы`;
      default:
        return `контрактная ${gearboxLabel} ${searchTerm}${oemSuffix} ${vehicleDesc}`;
    }
  }
  const gearboxCode = stripParenthetical(searchTerm);
  const makePart = make ? `${make} ` : "";
  switch (origin) {
    case "japan":
      return `${gearboxLabel} ${makePart}${gearboxCode}${oemSuffix} контрактная б/у из Японии`;
    case "europe":
      return `${gearboxLabel} ${makePart}${gearboxCode}${oemSuffix} контрактная б/у из Европы`;
    default:
      return `${gearboxLabel} ${makePart}${gearboxCode}${oemSuffix} контрактная б/у`;
  }
}

function buildFallbackQuery(
  oem: string,
  modelName: string | null,
  gearboxLabel: string,
  make?: string | null,
  vehicleDesc?: string | null
): string {
  const searchTerm = resolveSearchTerm(oem, modelName);
  const oemSuffix = searchTerm !== oem ? ` ${oem}` : '';
  if (vehicleDesc) {
    return `контрактная ${gearboxLabel} ${searchTerm}${oemSuffix} ${vehicleDesc} цена купить`;
  }
  const gearboxCode = stripParenthetical(searchTerm);
  const makePart = make ? `${make} ` : "";
  return `контрактная ${gearboxLabel} ${makePart}${gearboxCode}${oemSuffix} цена купить`;
}

function isExcluded(text: string): boolean {
  const lower = text.toLowerCase();
  return EXCLUDE_KEYWORDS.some((kw) => lower.includes(kw));
}

function isDefective(text: string): boolean {
  const lower = text.toLowerCase();
  return DEFECT_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()));
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

interface ParsedListing {
  title: string;
  price: number;
  mileage: number | null;
  url: string;
  site: string;
  isUsed: boolean;
}

function removeOutliers(prices: number[]): number[] {
  if (prices.length < 4) return prices;

  const sorted = [...prices].sort((a, b) => a - b);
  const q1 = sorted[Math.floor(sorted.length * 0.25)];
  const q3 = sorted[Math.floor(sorted.length * 0.75)];
  const iqr = q3 - q1;

  const lowerBound = q1 - 1.5 * iqr;
  const upperBound = q3 + 1.5 * iqr;

  return prices.filter(p => p >= lowerBound && p <= upperBound);
}

function validatePrices(listings: ParsedListing[]): ParsedListing[] {
  if (listings.length < 2) return listings;

  const prices = listings.map(l => l.price).sort((a, b) => a - b);
  const median = prices[Math.floor(prices.length / 2)];

  // Filter out any listing where price < 1% of median
  // e.g. median=180000, threshold=1800 — catches unconverted USD/JPY
  return listings.filter(l => {
    if (l.price < median * 0.01) {
      console.warn(
        `[PriceSearcher] Suspicious price ${l.price} RUB from ${l.site} ` +
        `(${(l.price / median * 100).toFixed(1)}% of median ${median}) — excluded`
      );
      return false;
    }
    return true;
  });
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
        // Accept both {site, url} (old format) and {source} (new flexible format)
        const siteValue = String(item.site ?? item.source ?? extractSiteName(String(item.url ?? "")));
        listings.push({
          title: String(item.title ?? ""),
          price,
          mileage: typeof item.mileage === "number" ? item.mileage : parseMileageFromText(String(item.mileage ?? "")),
          url: String(item.url ?? ""),
          site: siteValue,
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
  origin: Origin,
  make?: string | null,
  vehicleContext?: VehicleContext | null
): Promise<PriceSearchResult> {
  const vehicleDesc =
    vehicleContext?.make && vehicleContext?.model
      ? `${vehicleContext.make} ${vehicleContext.model}`
      : null;

  // Derive correct Russian gearbox label from vehicleContext.
  // BUG 4: null/unknown gearboxType uses neutral "КПП" to avoid incorrect
  // АКПП in search queries and customer-facing responses.
  const gearboxLabel =
    vehicleContext?.gearboxType === "MT" ? "МКПП" :
    vehicleContext?.gearboxType === "CVT" ? "вариатор" :
    vehicleContext?.gearboxType === "AT" ? "АКПП" :
    "КПП";

  const primaryQuery = buildPrimaryQuery(oem, modelName, origin, gearboxLabel, make, vehicleDesc);
  const fallbackQuery = buildFallbackQuery(oem, modelName, gearboxLabel, make, vehicleDesc);

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

  // Russian market search — flexible price extraction, any Russian auto parts source
  const runSearch = async (query: string): Promise<ParsedListing[]> => {
    console.log(`[PriceSearcher] Web search query: "${query}"`);
    const input =
      query +
      "\n\nSearch the Russian internet for prices of this used контрактная transmission.\n" +
      "Find ANY price mentions from ANY source — marketplaces, dealer sites, price aggregators, forums, any Russian автозапчасти website.\n" +
      "For each price found, return a JSON array item:\n" +
      '{"price": <number in RUB, integers only>, "source": "<domain name>", "title": "<brief description>"}.\n' +
      "If a source shows a price range (e.g. 'от 70 000 до 120 000 ₽'), create TWO entries with min and max.\n" +
      "Do NOT require mileage or other structured fields.\n" +
      "Return ONLY a valid JSON array. If nothing found, return [].\n" +
      "EXCLUDE new and rebuilt units. INCLUDE only б/у, контрактные, с разборки.";
    console.log('[PriceSearcher] Full search prompt:', input.substring(0, 1000));
    try {
      const response = await (openai as any).responses.create({
        model: "gpt-4.1",
        tools: [{ type: "web_search" }],
        input,
      });

      const content: string = response.output_text ?? "";
      console.log('[PriceSearcher] Raw GPT response:', content.substring(0, 2000));
      const parsed = validatePrices(parseListingsFromResponse(content));
      console.log('[PriceSearcher] Parsed listings count (price-validated):', parsed.length);
      return parsed;
    } catch (err: any) {
      console.warn(`[PriceSearcher] OpenAI web search failed: ${err.message}`);
      return [];
    }
  };

  // International fallback — searches Yahoo Auctions Japan, eBay, JDM/EU parts sites
  // and converts prices to RUB using fixed Feb-2026 exchange rates
  const runInternationalSearch = async (): Promise<ParsedListing[]> => {
    const searchDesc = modelName ?? oem;
    const input =
      `Search international websites for prices of this used transmission: ${searchDesc} OEM ${oem}.\n` +
      `Look on: Yahoo Auctions Japan (ヤフオク), eBay, JDM parts sites, ` +
      `European parts dealers, any non-Russian auto parts website.\n` +
      `For each price found, convert to Russian Rubles using these exchange rates (February 2026):\n` +
      `1 JPY = 0.50 RUB\n1 USD = 76.8 RUB\n1 EUR = 90.4 RUB\n1 GBP = 103 RUB\n` +
      `Return a JSON array: {"price": <converted RUB integer>, "source": "<site>", "title": "<description (original price in original currency)>"}.\n` +
      `If price range found, return two entries (min and max).\n` +
      `Return ONLY a valid JSON array. If nothing found, return [].`;
    console.log('[PriceSearcher] Full search prompt:', input.substring(0, 1000));
    try {
      const response = await (openai as any).responses.create({
        model: "gpt-4.1",
        tools: [{ type: "web_search" }],
        input,
      });

      const content: string = response.output_text ?? "";
      console.log('[PriceSearcher] Raw GPT response (international):', content.substring(0, 2000));
      const parsed = validatePrices(parseListingsFromResponse(content));
      console.log('[PriceSearcher] International parsed listings:', parsed.length);
      return parsed;
    } catch (err: any) {
      console.warn(`[PriceSearcher] International web search failed: ${err.message}`);
      return [];
    }
  };

  // Primary Russian search
  let rawListings = await runSearch(primaryQuery);
  let usedQuery = primaryQuery;

  // International fallback when primary Russian search returns nothing
  if (rawListings.length === 0) {
    console.log('[PriceSearcher] No Russian results, trying international search...');
    const intlResults = await runInternationalSearch();
    console.log(`[PriceSearcher] International search yielded ${intlResults.length} listings`);
    rawListings = intlResults;
  }

  // Filter: exclude new/rebuilt and defective/damaged units
  let filteredOut = 0;
  let listings = rawListings.filter((l) => {
    if (isExcluded(l.title)) {
      filteredOut++;
      return false;
    }
    if (isDefective(l.title)) {
      console.log(`[PriceSearcher] Excluded defective listing: "${l.title}" (${l.price} RUB)`);
      filteredOut++;
      return false;
    }
    return true;
  });
  console.log(`[PriceSearcher] After keyword filter (primary): ${listings.length} kept, ${filteredOut} excluded`);

  // Russian fallback search if still < 2 valid listings
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
      if (isDefective(l.title)) {
        console.log(`[PriceSearcher] Excluded defective listing: "${l.title}" (${l.price} RUB)`);
        filteredOut++;
        return false;
      }
      return true;
    });
    console.log(`[PriceSearcher] After keyword filter (fallback): ${listings.length} kept, ${filteredOut} excluded`);
  }

  if (listings.length < 2) {
    console.log(`[PriceSearcher] Not enough listings found for OEM "${oem}" (${listings.length} valid)`);
    return { ...notFoundResult, searchQuery: usedQuery, filteredOutCount: filteredOut };
  }

  // Remove outliers > 3x median
  const validPrices = removeOutliers(listings.map((l) => l.price));
  const validListings = listings.filter((l) => validPrices.includes(l.price));
  console.log(`[PriceSearcher] After outlier removal: ${validListings.length} kept (before: ${listings.length})`);

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
