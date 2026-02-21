import { openai } from "./decision-engine";

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
 *
 * Returns all nulls with confidence: 'low' on parse failure.
 */
export async function identifyTransmissionByOem(
  oem: string
): Promise<TransmissionIdentification> {
  try {
    const userPrompt =
      `OEM code: ${oem}. ` +
      `Identify: modelName (e.g. "JATCO JF011E"), manufacturer (e.g. "JATCO", "Aisin", "ZF"), ` +
      `origin (japan/europe/korea/usa/unknown), confidence (high/medium/low), notes (brief explanation).`;

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
