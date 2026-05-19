const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

type FuelPoint = { pricePerLitre: number; fscPct: number; vectorId?: number; label?: string };

const vectors: Record<string, number> = {
  AB: 735139, BC: 735140, MB: 735135, NB: 65584804, NL: 65584802,
  NS: 65584803, ON: 735148, PE: 735144, QC: 735146, SK: 735136,
  YT: 735142, NT: 735143,
};

const fallback: Record<string, FuelPoint> = {
  AB: { pricePerLitre: 1.64, fscPct: 25.0 }, BC: { pricePerLitre: 1.86, fscPct: 29.0 },
  MB: { pricePerLitre: 1.70, fscPct: 26.3 }, NB: { pricePerLitre: 1.78, fscPct: 27.8 },
  NL: { pricePerLitre: 1.86, fscPct: 29.0 }, NS: { pricePerLitre: 1.79, fscPct: 28.0 },
  ON: { pricePerLitre: 1.74, fscPct: 26.7 }, PE: { pricePerLitre: 1.78, fscPct: 27.8 },
  QC: { pricePerLitre: 1.82, fscPct: 28.4 }, SK: { pricePerLitre: 1.69, fscPct: 26.1 },
  YT: { pricePerLitre: 1.94, fscPct: 30.4 }, NT: { pricePerLitre: 1.98, fscPct: 31.0 },
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });
}

function fscFromPrice(pricePerLitre: number) {
  if (!Number.isFinite(pricePerLitre) || pricePerLitre <= 0) return 0;
  return Math.max(0, Math.round(((pricePerLitre - 1.10) / 0.024) * 10) / 10);
}

function extractValue(row: any): { value?: number; ref?: string } {
  const point = row?.object?.vectorDataPoint?.[0] || row?.vectorDataPoint?.[0] || row?.object || row;
  const raw = point?.value ?? point?.VALUE ?? point?.scalarFactorCode ?? null;
  const value = Number(raw);
  const ref = String(point?.refPer || point?.REF_PER || point?.referencePeriod || "");
  return { value: Number.isFinite(value) ? value : undefined, ref };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "GET") return json({ error: "method_not_allowed" }, 405);
  try {
    const payload = Object.entries(vectors).map(([, vectorId]) => ({ vectorId, latestN: 1 }));
    const res = await fetch("https://www150.statcan.gc.ca/t1/wds/rest/getDataFromVectorsAndLatestNPeriods", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`statscan ${res.status}`);
    const data = await res.json();
    const out: Record<string, FuelPoint> = {};
    let asOf = "";
    Object.entries(vectors).forEach(([prov, vectorId], idx) => {
      const point = extractValue(Array.isArray(data) ? data[idx] : null);
      const price = point.value && point.value > 10 ? point.value / 100 : point.value;
      const base = fallback[prov];
      const pricePerLitre = Number.isFinite(price || NaN) && (price || 0) > 0 ? Number(price) : base.pricePerLitre;
      out[prov] = { pricePerLitre, fscPct: fscFromPrice(pricePerLitre) || base.fscPct, vectorId, label: prov };
      if (!asOf && point.ref) asOf = point.ref;
    });
    return json({
      ok: true,
      source: "Statistics Canada WDS",
      asOf: asOf || new Date().toISOString().slice(0, 10),
      national: out.ON,
      provinces: out,
    });
  } catch (e) {
    return json({
      ok: true,
      fallback: true,
      source: "Fallback diesel table",
      asOf: new Date().toISOString().slice(0, 10),
      national: fallback.ON,
      provinces: fallback,
      warning: e instanceof Error ? e.message : String(e),
    });
  }
});
