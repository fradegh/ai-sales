export interface PartsApiResult {
  make: string | null;
  modelName: string | null;
  year: string | null;
  engineCode: string | null;
  kpp: string | null;
}

/**
 * Decodes a VIN via partsapi.ru VINdecodeOE method.
 * Returns structured vehicle metadata (make, model, year, engine code, gearbox code).
 * The apiKey must be passed by the caller — fetch it from the global secrets store
 * using getSecret({ scope: "global", keyName: "PARTSAPI_KEY" }).
 */
export async function decodeVinPartsApi(vin: string, apiKey: string): Promise<PartsApiResult | null> {
  try {
    const url = `https://api.partsapi.ru?method=VINdecodeOE&key=${apiKey}&vin=${encodeURIComponent(vin)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    const json = await res.json();
    const d = json?.data?.array;
    if (!d) return null;

    // Extract engine code from strings like "G4GC3584975" or "1400CC / 150hp / 110kW TSI"
    let engineCode: string | null = null;
    const engRaw = String(d.dvigately ?? d.nomer_dvigatelya ?? "");
    const engMatch = engRaw.match(/\b([A-Z]{2,5}\d{0,4}[A-Z]{0,3})\b/);
    if (engMatch) engineCode = engMatch[1];

    // Clean model name: "Jetta 1,4 (TRENDLINE)" → "Jetta", "Santa Fe" → "Santa Fe"
    const rawName: string | null = d.naimenovanie ?? null;
    const modelName = rawName
      ? rawName.replace(/[\d,\(].*$/, "").trim() || rawName
      : null;

    return {
      make: d.brend ?? null,
      modelName,
      year: d.vypushcheno
        ? String(d.vypushcheno)
        : d.modelynyj_god
          ? String(d.modelynyj_god)
          : null,
      engineCode,
      kpp: d.kpp ?? null,
    };
  } catch (e) {
    console.warn("[PartsAPI] VIN decode failed:", e);
    return null;
  }
}
