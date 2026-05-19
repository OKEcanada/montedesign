import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

function splitCity(q: string): { city: string; prov: string | null } {
  const m = (q || "").trim().match(/^(.*?)\s*,\s*([A-Z]{2})\s*$/);
  if (m) return { city: m[1].trim(), prov: m[2] };
  return { city: (q || "").trim(), prov: null };
}

async function geocode(q: string) {
  const { city, prov } = splitCity(q);
  if (!city) return null;
  const u = new URL("https://geocoding-api.open-meteo.com/v1/search");
  u.searchParams.set("name", city);
  u.searchParams.set("count", "5");
  u.searchParams.set("language", "en");
  const r = await fetch(u.toString());
  if (!r.ok) return null;
  const j = await r.json();
  const results = (j?.results || []).filter((x: any) => x.country_code === "CA");
  let hit = results[0];
  if (prov && results.length) {
    const provMap: Record<string, string> = {
      BC: "British Columbia", AB: "Alberta", SK: "Saskatchewan", MB: "Manitoba",
      ON: "Ontario", QC: "Quebec", NB: "New Brunswick", NS: "Nova Scotia",
      PE: "Prince Edward Island", NL: "Newfoundland and Labrador",
      YT: "Yukon", NT: "Northwest Territories", NU: "Nunavut",
    };
    const wantAdmin = provMap[prov];
    const better = results.find((x: any) => x.admin1 === wantAdmin);
    if (better) hit = better;
  }
  if (!hit) return null;
  return { name: hit.name, admin1: hit.admin1, lat: hit.latitude, lon: hit.longitude };
}

async function forecast(lat: number, lon: number) {
  const u = new URL("https://api.open-meteo.com/v1/forecast");
  u.searchParams.set("latitude", String(lat));
  u.searchParams.set("longitude", String(lon));
  u.searchParams.set("current", "temperature_2m,weather_code,wind_speed_10m,precipitation");
  u.searchParams.set("daily", "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,snowfall_sum,wind_speed_10m_max");
  u.searchParams.set("timezone", "auto");
  u.searchParams.set("forecast_days", "3");
  const r = await fetch(u.toString());
  if (!r.ok) return null;
  return await r.json();
}

function codeLabel(c: number): string {
  if (c == null) return "—";
  if (c === 0) return "Clear";
  if (c <= 3) return "Mostly clear";
  if (c <= 48) return "Fog";
  if (c <= 57) return "Drizzle";
  if (c <= 67) return "Rain";
  if (c <= 77) return "Snow";
  if (c <= 82) return "Showers";
  if (c <= 86) return "Snow showers";
  return "Thunderstorm";
}
function codeEmoji(c: number): string {
  if (c == null) return "❔";
  if (c === 0) return "☀️";
  if (c <= 3) return "🌤️";
  if (c <= 48) return "🌫️";
  if (c <= 67) return "🌧️";
  if (c <= 77) return "❄️";
  if (c <= 86) return "🌨️";
  return "⛈️";
}

function riskFor(daily: any): { score: number; label: string; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  if (!daily) return { score: 0, label: "unknown", reasons };
  const snow = (daily.snowfall_sum ?? []).slice(0, 2).reduce((a: number, b: number) => a + (b || 0), 0);
  const rain = (daily.precipitation_sum ?? []).slice(0, 2).reduce((a: number, b: number) => a + (b || 0), 0);
  const minT = Math.min(...((daily.temperature_2m_min ?? []).slice(0, 2)));
  const wind = Math.max(...((daily.wind_speed_10m_max ?? []).slice(0, 2)));
  if (snow > 5) { score += 3; reasons.push(`${snow.toFixed(1)} cm snow expected`); }
  else if (snow > 1) { score += 2; reasons.push(`${snow.toFixed(1)} cm snow possible`); }
  if (rain > 30) { score += 2; reasons.push(`${rain.toFixed(0)} mm heavy rain`); }
  if (minT <= -15) { score += 2; reasons.push(`extreme cold (${minT.toFixed(0)}°C)`); }
  else if (minT <= -5) { score += 1; reasons.push(`cold (${minT.toFixed(0)}°C)`); }
  if (wind >= 50) { score += 2; reasons.push(`high winds (${wind.toFixed(0)} km/h)`); }
  const label = score >= 5 ? "high" : score >= 3 ? "moderate" : score >= 1 ? "low" : "clear";
  return { score, label, reasons };
}

async function lookup(q: string) {
  const g = await geocode(q);
  if (!g) return null;
  const f = await forecast(g.lat, g.lon);
  if (!f) return { place: g, current: null, daily: null, risk: { score: 0, label: "unknown", reasons: [] } };
  const code = f.current?.weather_code;
  return {
    place: g,
    current: {
      temperatureC: f.current?.temperature_2m,
      windKph: f.current?.wind_speed_10m,
      precipMm: f.current?.precipitation,
      label: codeLabel(code),
      emoji: codeEmoji(code),
    },
    daily: f.daily,
    risk: riskFor(f.daily),
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  const origin = url.searchParams.get("origin");
  const destination = url.searchParams.get("destination");
  if (!origin && !destination) {
    return new Response(JSON.stringify({ error: "origin or destination required" }), {
      status: 400, headers: { "content-type": "application/json", ...CORS },
    });
  }
  const [o, d] = await Promise.all([
    origin ? lookup(origin) : Promise.resolve(null),
    destination ? lookup(destination) : Promise.resolve(null),
  ]);
  return new Response(JSON.stringify({ origin: o, destination: d }), {
    headers: { "content-type": "application/json", "cache-control": "public, max-age=900", ...CORS },
  });
});
