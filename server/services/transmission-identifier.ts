import { openai } from "./decision-engine";

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

const SYSTEM_PROMPT =
  "You are an automotive transmission expert. " +
  "Given an OEM/part number, identify the exact transmission model. " +
  "Return the modelName as the market/commercial name used in Russian контрактные АКПП listings " +
  "(e.g. 'F4A42', 'U660E', 'A4CF1', 'AW55-51SN') — NOT internal catalog codes or part numbers. " +
  "If unsure of the exact model, return the most likely market model name for this vehicle. " +
  "For Hyundai/Mitsubishi transmissions: " +
  "- F4A42 is used in Hyundai Elantra/Tiburon 2.0L (G4GC engine), 4-speed; " +
  "- A4AF3 is used in Hyundai Accent/Getz 1.5L, 4-speed; " +
  "- F4A51 is used in Hyundai Sonata/Santa Fe 2.0-2.7L. " +
  "Use engine code and vehicle model to disambiguate. " +
  "Respond ONLY in valid JSON, no markdown.";

const FALLBACK_RESULT: TransmissionIdentification = {
  modelName: null,
  manufacturer: null,
  origin: "unknown",
  confidence: "low",
  notes: "Could not identify transmission from OEM code",
};

/**
 * Identifies a transmission model from an OEM/part number using GPT-4o-mini.
 * No web search needed — the model has knowledge of OEM codes.
 * Optionally accepts vehicle context to improve identification accuracy.
 *
 * Returns all nulls with confidence: 'low' on parse failure.
 */
export async function identifyTransmissionByOem(
  oem: string,
  context?: VehicleContext
): Promise<TransmissionIdentification> {
  try {
    console.log(`[TransmissionIdentifier] vehicleContext received:`, JSON.stringify(context ?? null));

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
    console.log("[TransmissionIdentifier] Full GPT prompt:\n" + userPrompt);

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      temperature: 0,
      max_tokens: 256,
    });

    const raw = response.choices[0]?.message?.content?.trim() ?? "";
    console.log(`[TransmissionIdentifier] GPT response: ${JSON.stringify(raw)}`);
    const parsed = JSON.parse(raw) as Partial<TransmissionIdentification>;

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
