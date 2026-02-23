import { openai } from "./decision-engine";
import { sanitizeForLog } from "../utils/sanitizer";

export interface VehicleContext {
  make?: string | null;
  model?: string | null;
  year?: string | null;
  engine?: string | null;
  body?: string | null;
  driveType?: string | null;
  gearboxModelHint?: string | null;
  factoryCode?: string | null;
  gearboxType?: string | null;
  displacement?: string | null;
  partsApiRawData?: Record<string, unknown> | null;
}

export interface TransmissionIdentification {
  modelName: string | null;       // e.g. "JATCO JF011E"
  manufacturer: string | null;    // e.g. "JATCO", "Aisin", "ZF", "Getrag"
  origin: "japan" | "europe" | "korea" | "usa" | "unknown";
  confidence: "high" | "medium" | "low";
  notes: string;
}

const SYSTEM_PROMPT = `You are an expert in automotive transmissions. Your task is to identify the exact market/commercial transmission model name based on OEM code and vehicle data.

CRITICAL RULES:
1. Return modelName EXACTLY as it appears in Russian контрактные КПП marketplace listings (e.g. 'F4A42', 'W5MBB', 'S6FA', 'QCE', 'U660E') — NOT internal catalog codes or part numbers.
2. If vehicle data contains "modifikaciya" or "opcii" field — READ IT CAREFULLY to determine transmission type:
   - "5FM/T" or "5MT" or "FM/T" = 5-speed MANUAL (МКПП). Do NOT return CVT or automatic.
   - "6FM/T" or "6MT" = 6-speed MANUAL (МКПП)
   - "4AT" or "4A/T" = 4-speed AUTOMATIC (АКПП)
   - "5AT" or "5A/T" = 5-speed AUTOMATIC (АКПП)
   - "CVT" or "CVT8" = continuously variable transmission (вариатор)
   - "S6FA/T" = S6FA series, MANUAL
3. For Mitsubishi Lancer CY4A with "5FM/T":
   - W5MBB = 5-speed manual, 4WD (most common for Lancer 4WD)
   - W5M51 = 5-speed manual, 2WD
   - Look at drive type: "4WD" → W5MBB, "2WD"/"FWD" → W5M51
4. The "modifikaciya" field is the most reliable source for transmission type — always prioritize it over general knowledge.
5. Return JSON only: { modelName, manufacturer, origin, confidence, notes }

When identifying the transmission model — use web search to verify:
Search for the OEM code and vehicle data to find the exact transmission model name
used in Russian and Japanese parts listings.
Example queries: "OEM 310203VX2D Nissan X-Trail коробка передач модель"
or "Nissan X-Trail NT32 MR20DD CVT модель вариатора"
Return the market model name (e.g. JF016E, K313, W5MBB) confirmed by actual listings.
If web search confirms the model — set confidence: "high".
If web search is inconclusive — set confidence: "medium".`;

const FALLBACK_RESULT: TransmissionIdentification = {
  modelName: null,
  manufacturer: null,
  origin: "unknown",
  confidence: "low",
  notes: "Could not identify transmission from OEM code",
};

/**
 * Identifies a transmission model from an OEM/part number using GPT-4.1 + web_search.
 * Searches the web to verify the exact market model name used in Russian/Japanese listings.
 * Optionally accepts vehicle context to improve identification accuracy.
 *
 * Returns all nulls with confidence: 'low' on parse failure.
 */
export async function identifyTransmissionByOem(
  oem: string,
  context?: VehicleContext
): Promise<TransmissionIdentification> {
  try {
    console.log(`[TransmissionIdentifier] vehicleContext received:`, JSON.stringify(sanitizeForLog(context ?? null)));

    const lines: string[] = [`OEM code: ${oem}.`];

    if (context?.partsApiRawData) {
      lines.push(`Full vehicle data from OEM catalog:`);
      lines.push(JSON.stringify(context.partsApiRawData, null, 2));
    } else {
      if (context?.make || context?.model) {
        lines.push(`Vehicle: ${[context.make, context.model].filter(Boolean).join(" ")}`);
      }
      if (context?.year) lines.push(`Year: ${context.year}`);
      if (context?.engine) lines.push(`Engine code: ${context.engine}`);
      if (context?.driveType) lines.push(`Drive type: ${context.driveType}`);
      if (context?.gearboxModelHint) lines.push(`Gearbox model hint: ${context.gearboxModelHint}`);
    }

    lines.push(`\nBased on the above vehicle data and OEM code, identify the transmission.`);
    lines.push(`Return modelName as it appears in Russian контрактные КПП listings (e.g. 'F4A42', 'W5MBB', 'S6FA', 'QCE') — NOT internal catalog or part numbers.`);
    lines.push(`Identify: modelName, manufacturer, origin, confidence, notes.`);

    const userPrompt = lines.join("\n");
    const input = SYSTEM_PROMPT + "\n\n" + userPrompt;
    console.log("[TransmissionIdentifier] Full GPT prompt:\n" + input);

    const response = await (openai as any).responses.create({
      model: "gpt-4.1",
      tools: [{ type: "web_search" }],
      input,
    });

    const raw: string = response.output_text ?? "";
    const stripped = raw.trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```\s*$/i, "")
      .trim();

    console.log("[TransmissionIdentifier] GPT response:", raw);
    console.log("[TransmissionIdentifier] Stripped response:", stripped);

    const parsed = JSON.parse(stripped) as Partial<TransmissionIdentification>;

    const validOrigins = ["japan", "europe", "korea", "usa", "unknown"] as const;
    const validConfidences = ["high", "medium", "low"] as const;

    return {
      modelName: typeof parsed.modelName === "string" ? parsed.modelName : null,
      manufacturer: typeof parsed.manufacturer === "string" ? parsed.manufacturer : null,
      origin: validOrigins.includes(parsed.origin as any)
        ? (parsed.origin as TransmissionIdentification["origin"])
        : "unknown",
      confidence: validConfidences.includes(parsed.confidence as any)
        ? (parsed.confidence as TransmissionIdentification["confidence"])
        : "low",
      notes: typeof parsed.notes === "string" ? parsed.notes : "",
    };
  } catch (err: any) {
    console.warn(`[TransmissionIdentifier] Failed to identify OEM "${oem}": ${err.message}`);
    return FALLBACK_RESULT;
  }
}
