const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const webhook = Deno.env.get("SLACK_WEBHOOK_URL") || "";
  const body = await req.json().catch(() => ({}));
  const event = String(body.event || body.type || "quote.event");
  const payload = body.payload || body;
  if (!webhook) return json({ ok: true, skipped: true, reason: "SLACK_WEBHOOK_URL not configured" });

  const text = [
    `*${event.replace(/\./g, " ")}*`,
    payload.quote_ref ? `Quote: ${payload.quote_ref}` : null,
    payload.origin || payload.destination ? `Lane: ${payload.origin || "-"} -> ${payload.destination || "-"}` : null,
    payload.total ? `Total: $${Number(payload.total).toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : null,
    payload.customer || payload.email || payload.phone ? `Contact: ${[payload.customer, payload.email, payload.phone].filter(Boolean).join(" | ")}` : null,
    payload.share_url ? payload.share_url : null,
  ].filter(Boolean).join("\n");

  const res = await fetch(webhook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) return json({ ok: false, status: res.status, detail: await res.text().catch(() => "") }, 502);
  return json({ ok: true });
});
