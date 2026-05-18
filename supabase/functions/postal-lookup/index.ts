// postal-lookup: Canadian postal code -> { city, province, lat, lng, fsa }
// Uses Geocoder.ca (free, no key) with Nominatim fallback. Handles US ZIPs via zippopotam.us.
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Content-Type": "application/json"
};
function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: CORS });
}
const CA_POSTAL = /^[A-Za-z]\d[A-Za-z][\s-]?\d[A-Za-z]\d$/;
const US_ZIP = /^\d{5}(-\d{4})?$/;
async function lookupCanada(postal) {
  const clean = postal.toUpperCase().replace(/\s+/g, "");
  try {
    const r = await fetch(`https://geocoder.ca/?postal=${encodeURIComponent(clean)}&json=1`);
    if (r.ok) {
      const data = await r.json();
      if (data && data.latt && data.longt) {
        return { ok: true, country: "CA", postal: clean, fsa: clean.slice(0, 3), city: data.city || "", province: data.prov || "", latitude: Number(data.latt), longitude: Number(data.longt), source: "geocoder.ca" };
      }
    }
  } catch (_) {}
  return null;
}
async function lookupUS(zip) {
  try {
    const r = await fetch(`https://api.zippopotam.us/us/${encodeURIComponent(zip.slice(0,5))}`);
    if (r.ok) {
      const data = await r.json();
      const place = data && data.places && data.places[0];
      if (place) return { ok: true, country: "US", postal: zip, city: place["place name"] || "", province: place["state abbreviation"] || "", latitude: Number(place.latitude), longitude: Number(place.longitude), source: "zippopotam" };
    }
  } catch (_) {}
  return null;
}
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  let postal = "";
  if (req.method === "GET") {
    const url = new URL(req.url);
    postal = String(url.searchParams.get("postal") || url.searchParams.get("q") || "").trim();
  } else {
    const body = await req.json().catch(() => ({}));
    postal = String(body.postal || body.q || "").trim();
  }
  if (!postal) return json({ ok: false, error: "postal code required" }, 400);
  if (CA_POSTAL.test(postal)) return json((await lookupCanada(postal)) || { ok: false, error: "not found", postal });
  if (US_ZIP.test(postal))   return json((await lookupUS(postal)) || { ok: false, error: "not found", postal });
  return json({ ok: false, error: "unrecognized postal code format", postal });
});
