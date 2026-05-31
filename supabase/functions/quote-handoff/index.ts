const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const HANDOFF_PREFIX = "wix-handoff:";
const HANDOFF_TTL_MS = 3 * 60 * 1000;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}

function text(v: unknown) {
  return String(v ?? "").trim();
}

function supabaseEnv() {
  const url = text(Deno.env.get("SUPABASE_URL")).replace(/\/+$/, "");
  const serviceKey = text(Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"));
  const anonKey = text(Deno.env.get("SUPABASE_ANON_KEY"));
  if (!url || !serviceKey) throw new Error("Supabase service role is not configured");
  return { url, serviceKey, anonKey: anonKey || serviceKey };
}

async function rest(path: string, init: RequestInit = {}) {
  const env = supabaseEnv();
  const headers = new Headers(init.headers || {});
  headers.set("apikey", env.serviceKey);
  headers.set("authorization", `Bearer ${env.serviceKey}`);
  if (!headers.has("content-type") && init.body) headers.set("content-type", "application/json");
  return fetch(`${env.url}${path}`, { ...init, headers });
}

async function getQuoteByToken(token: string) {
  const env = supabaseEnv();
  const res = await fetch(`${env.url}/rest/v1/rpc/get_quote_by_token`, {
    method: "POST",
    headers: {
      apikey: env.anonKey,
      authorization: `Bearer ${env.anonKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ share_token: token }),
  });
  if (!res.ok) throw new Error(`Quote lookup failed: ${res.status}`);
  const rows = await res.json();
  return Array.isArray(rows) ? rows[0] : rows;
}

async function createHandoff(token: string, signature: string, userAgent: string) {
  const quote = await getQuoteByToken(token);
  if (!quote || !quote.id || !quote.public_token) return json({ ok: false, error: "quote_not_found" }, 404);
  const referrer = `${HANDOFF_PREFIX}${signature}`;
  const res = await rest("/rest/v1/quote_views", {
    method: "POST",
    headers: { prefer: "return=minimal" },
    body: JSON.stringify({
      quote_id: quote.id,
      public_token: quote.public_token,
      user_agent: userAgent.slice(0, 1000),
      referrer,
    }),
  });
  if (!res.ok) return json({ ok: false, error: await res.text() }, 500);
  return json({ ok: true });
}

async function resolveHandoff(signature: string) {
  const cutoff = new Date(Date.now() - HANDOFF_TTL_MS).toISOString();
  const referrer = `${HANDOFF_PREFIX}${signature}`;
  const params = new URLSearchParams({
    select: "id,public_token,viewed_at",
    referrer: `eq.${referrer}`,
    viewed_at: `gte.${cutoff}`,
    order: "viewed_at.desc",
    limit: "1",
  });
  const res = await rest(`/rest/v1/quote_views?${params.toString()}`);
  if (!res.ok) return json({ ok: false, error: await res.text() }, 500);
  const rows = await res.json();
  const row = Array.isArray(rows) ? rows[0] : null;
  if (!row || !row.public_token) return json({ ok: true, token: null });

  // Handoffs are one-time hints, not analytics. Remove the matching hint after use
  // so normal visits to the embedded calculator do not keep reopening an old quote.
  const cleanup = new URLSearchParams({ referrer: `eq.${referrer}` });
  rest(`/rest/v1/quote_views?${cleanup.toString()}`, { method: "DELETE" }).catch(() => {});
  return json({ ok: true, token: row.public_token });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
  try {
    const body = await req.json().catch(() => ({}));
    const action = text(body.action).toLowerCase();
    const signature = text(body.signature);
    if (!signature || signature.length < 12) return json({ ok: false, error: "bad_signature" }, 400);
    if (action === "create") {
      const token = text(body.token);
      if (!token) return json({ ok: false, error: "missing_token" }, 400);
      return await createHandoff(token, signature, text(body.userAgent));
    }
    if (action === "resolve") {
      return await resolveHandoff(signature);
    }
    return json({ ok: false, error: "bad_action" }, 400);
  } catch (e) {
    return json({ ok: false, error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
