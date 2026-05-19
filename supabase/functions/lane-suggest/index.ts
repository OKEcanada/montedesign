// lane-suggest: when an exact origin→destination lane isn't in the rate table,
// suggest the 5 closest rated lanes by combining:
//   1. Same origin to other destinations in the same province as destination
//   2. Closest origin to exact destination if no rated origin matches
// Used by the calculator + the admin to fill in missing lanes.
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Content-Type": "application/json"
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: CORS });
}
function prov(s: string) {
  const m = String(s || "").match(/,\s*([A-Z]{2})\s*$/i);
  return m ? m[1].toUpperCase() : null;
}
function city(s: string) {
  return String(s || "").split(",")[0].trim();
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  let origin = "", destination = "";
  if (req.method === "GET") {
    const u = new URL(req.url);
    origin = String(u.searchParams.get("origin") || "");
    destination = String(u.searchParams.get("destination") || "");
  } else {
    const body = await req.json().catch(() => ({}));
    origin = String(body.origin || "");
    destination = String(body.destination || "");
  }
  if (!origin || !destination) return json({ ok: false, error: "origin + destination required" }, 400);

  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !key) return json({ ok: false, error: "supabase config missing" }, 500);

  const supa = createClient(url, key, { auth: { persistSession: false } });

  // 1. Check if exact lane exists
  const { data: exact } = await supa
    .from("lane_rates")
    .select("origin,destination")
    .ilike("origin", origin.trim())
    .ilike("destination", destination.trim())
    .limit(1);
  if (exact && exact.length) {
    return json({ ok: true, exact: true, lane: exact[0], suggestions: [] });
  }

  const destProv = prov(destination);
  const destCity = city(destination);
  const suggestions: Array<{ origin: string; destination: string; reason: string; score: number }> = [];

  // 2. Same origin -> other destinations in same province
  if (destProv) {
    const { data: sameProv } = await supa
      .from("lane_rates")
      .select("origin,destination")
      .ilike("origin", origin.trim())
      .ilike("destination", `%, ${destProv}`)
      .limit(50);
    if (sameProv) {
      for (const r of sameProv) {
        const cityLetters = destCity.toUpperCase();
        const rCity = city(r.destination).toUpperCase();
        // Score by city-name similarity (shared prefix length)
        let score = 0;
        const minLen = Math.min(cityLetters.length, rCity.length);
        for (let i = 0; i < minLen; i++) {
          if (cityLetters[i] === rCity[i]) score++; else break;
        }
        suggestions.push({ origin: r.origin, destination: r.destination, reason: `Same origin → same province (${destProv})`, score: score + 10 });
      }
    }
  }

  // 3. Other origins -> destination province
  if (destProv) {
    const { data: otherOrigins } = await supa
      .from("lane_rates")
      .select("origin,destination")
      .ilike("destination", `%, ${destProv}`)
      .neq("origin", origin)
      .limit(50);
    if (otherOrigins) {
      for (const r of otherOrigins) {
        suggestions.push({ origin: r.origin, destination: r.destination, reason: `Different origin → ${destProv}`, score: 3 });
      }
    }
  }

  suggestions.sort((a, b) => b.score - a.score);
  return json({ ok: true, exact: false, suggestions: suggestions.slice(0, 5), origin, destination });
});
