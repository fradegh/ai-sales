import { openai } from "./decision-engine";

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/i;

/** Truncates base64 data: URLs so they are safe to include in log output. */
export function logSafeUrl(url: string): string {
  if (url.startsWith("data:")) {
    return url.substring(0, 50) + "...[base64 truncated]";
  }
  return url;
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
