import { openai } from "./decision-engine";

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/i;

/** Truncates base64 data: URLs so they are safe to include in log output. */
export function logSafeUrl(url: string): string {
  if (url.startsWith("data:")) {
    return url.substring(0, 50) + "...[base64 truncated]";
  }
  return url;
}

export type ImageAnalysisResult =
  | { type: "gearbox_tag"; code: string }
  | { type: "registration_doc"; vin: string | null; frame: string | null; make: string | null; model: string | null }
  | { type: "unknown" };

const IMAGE_ANALYSIS_PROMPT = `Analyze this image and determine what it shows.

TYPE 1 — Gearbox tag/label (шильдик КПП):
A metal or plastic label attached to a transmission with alphanumeric codes.
→ Extract the transmission model code (e.g. W5MBB, F4A42, RE4F03B)
→ Return: { "type": "gearbox_tag", "code": "<extracted code>" }

TYPE 2 — Vehicle registration document (свидетельство о регистрации ТС):
A Russian vehicle registration certificate showing VIN, Frame/Кузов number, make, model.
→ Extract VIN (17 chars) if present, OR Frame/Кузов number if VIN is absent/ОТСУТСТВУЕТ
→ Return: { "type": "registration_doc", "vin": "<VIN or null>", "frame": "<frame number or null>", "make": "<make or null>", "model": "<model or null>" }

TYPE 3 — Other / unclear:
→ Return: { "type": "unknown" }

Respond ONLY with a valid JSON object, no extra text, no markdown code fences.`;

/**
 * Uses GPT-4o vision to classify a single image and extract relevant data.
 * Returns typed ImageAnalysisResult.
 */
export async function analyzeImage(
  attachment: { url?: string; mimeType?: string }
): Promise<ImageAnalysisResult> {
  const url = attachment.url;
  if (!url) return { type: "unknown" };

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url, detail: "high" },
          },
          {
            type: "text",
            text: IMAGE_ANALYSIS_PROMPT,
          },
        ],
      },
    ],
    max_tokens: 200,
    temperature: 0,
  });

  const text = (response.choices[0]?.message?.content ?? "").trim();
  try {
    const jsonStr = text.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
    const parsed = JSON.parse(jsonStr) as ImageAnalysisResult;
    if (
      parsed.type === "gearbox_tag" ||
      parsed.type === "registration_doc" ||
      parsed.type === "unknown"
    ) {
      return parsed;
    }
  } catch {
    // fall through to unknown
  }

  return { type: "unknown" };
}

/**
 * Iterates over attachments and returns the first non-unknown ImageAnalysisResult.
 * Falls back to { type: "unknown" } if all attachments are unclassified or fail.
 */
export async function analyzeImages(
  attachments: Array<{ url?: string; mimeType?: string }>
): Promise<ImageAnalysisResult> {
  for (const attachment of attachments) {
    const url = attachment.url;
    if (!url) continue;

    console.log(`[VinOCR] Analyzing attachment: ${logSafeUrl(url)}`);

    try {
      const result = await analyzeImage(attachment);
      console.log(`[VinOCR] Image analysis result: ${JSON.stringify(result)}`);

      if (result.type !== "unknown") {
        return result;
      }
    } catch (e) {
      console.error(`[VinOCR] Failed to analyze attachment (${logSafeUrl(url)}):`, e);
    }
  }

  return { type: "unknown" };
}

/**
 * Uses GPT-4o vision to extract a VIN from image attachments.
 * Accepts HTTP/HTTPS URLs and data: URLs (base64-encoded images).
 * Returns the first valid 17-char VIN found, or null.
 */
export async function extractVinFromImages(
  attachments: Array<{ url?: string; mimeType?: string }>
): Promise<string | null> {
  for (const attachment of attachments) {
    const url = attachment.url;
    if (!url) continue;

    console.log(`[VinOCR] Processing attachment: ${logSafeUrl(url)}`);

    try {
      const response = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: { url, detail: "high" },
              },
              {
                type: "text",
                text:
                  "Extract the VIN number from this image. " +
                  "A VIN is exactly 17 characters: letters A-Z (no I, O, Q) and digits 0-9. " +
                  "Return ONLY the 17-character VIN with no spaces or punctuation. " +
                  "If no VIN is visible, return exactly: null",
              },
            ],
          },
        ],
        max_tokens: 50,
        temperature: 0,
      });

      const text = (response.choices[0]?.message?.content ?? "").trim();
      if (text && text !== "null" && VIN_RE.test(text)) {
        console.log(`[VinOCR] Extracted VIN: ${text}`);
        return text.toUpperCase();
      }

      console.log(`[VinOCR] No VIN found in attachment (response: "${text}")`);
    } catch (e) {
      console.error(`[VinOCR] Failed to process attachment (${logSafeUrl(url)}):`, e);
    }
  }

  return null;
}
