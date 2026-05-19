const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });
}

function city(label: string) {
  return String(label || "").split(",")[0]?.trim() || label;
}

async function geocode(label: string) {
  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.searchParams.set("name", city(label));
  url.searchParams.set("count", "10");
  url.searchParams.set("language", "en");
  url.searchParams.set("format", "json");
  url.searchParams.set("country", "CA");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`geocode ${res.status}`);
  const data = await res.json();
  const prov = String(label || "").match(/,\s*([A-Z]{2})\s*$/)?.[1];
  const rows = Array.isArray(data.results) ? data.results : [];
  const match = rows.find((r: any) => String(r.admin1 || "").toUpperCase().includes(String(prov || "").toUpperCase())) || rows[0];
  if (!match) throw new Error(`no geocode for ${label}`);
  return { latitude: Number(match.latitude), longitude: Number(match.longitude), name: match.name, province: match.admin1 };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  try {
    const body = await req.json().catch(() => ({}));
    const origin = String(body.origin || "");
    const destination = String(body.destination || "");
    if (!origin || !destination) return json({ ok: false, error: "origin and destination required" }, 400);
    const [o, d] = await Promise.all([geocode(origin), geocode(destination)]);
    const routeUrl = `https://router.project-osrm.org/route/v1/driving/${o.longitude},${o.latitude};${d.longitude},${d.latitude}?overview=false&alternatives=false&steps=false`;
    const routeRes = await fetch(routeUrl);
    if (!routeRes.ok) throw new Error(`osrm ${routeRes.status}`);
    const route = await routeRes.json();
    const r = route?.routes?.[0];
    if (!r) throw new Error("no route");
    return json({
      ok: true,
      origin,
      destination,
      distance_km: Math.round((Number(r.distance) || 0) / 1000),
      duration_hours: Math.round(((Number(r.duration) || 0) / 3600) * 10) / 10,
      source: "Open-Meteo geocoding + OSRM",
      geocoded: { origin: o, destination: d },
    });
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
