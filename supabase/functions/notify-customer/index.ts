const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });
}

function htmlEsc(v: unknown) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

async function sendResend(to: string, subject: string, html: string, text: string) {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) return null;
  const from = Deno.env.get("MAIL_FROM") || "One Kind Express <quotes@onekindexpress.com>";
  const bcc = Deno.env.get("OKE_NOTIFY_EMAIL") || "info@onekindexpress.com";
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ from, to: [to], bcc: [bcc], subject, html, text }),
  });
  return { provider: "resend", res };
}

async function sendBrevo(to: string, subject: string, html: string, text: string) {
  const key = Deno.env.get("BREVO_API_KEY");
  if (!key) return null;
  const senderEmail = Deno.env.get("MAIL_SENDER_EMAIL") || "info@onekindexpress.com";
  const senderName = Deno.env.get("MAIL_SENDER_NAME") || "One Kind Express";
  const notify = Deno.env.get("OKE_NOTIFY_EMAIL") || "info@onekindexpress.com";
  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "content-type": "application/json", "api-key": key },
    body: JSON.stringify({
      sender: { name: senderName, email: senderEmail },
      to: [{ email: to }],
      bcc: [{ email: notify }],
      subject,
      htmlContent: html,
      textContent: text,
    }),
  });
  return { provider: "brevo", res };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const body = await req.json().catch(() => ({}));
  const email = String(body.email || body.to || body.payload?.email || "").trim();
  const name = String(body.name || body.payload?.customer || "there").trim();
  const payload = body.payload || {};
  if (!email || !email.includes("@")) return json({ ok: false, error: "customer email required" }, 400);

  const subject = `One Kind Express received your quote request${payload.quote_ref ? ` ${payload.quote_ref}` : ""}`;
  const lines = [
    `Hi ${name || "there"},`,
    "",
    "Done. One Kind Express has your quote request and contact details.",
    "Our team will review the shipment and follow up with next steps.",
    "",
    payload.quote_ref ? `Quote: ${payload.quote_ref}` : null,
    payload.origin || payload.destination ? `Lane: ${payload.origin || "-"} -> ${payload.destination || "-"}` : null,
    payload.total ? `Quoted total: $${Number(payload.total).toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : null,
    payload.share_url ? `Quote link: ${payload.share_url}` : null,
    "",
    "One Kind Express",
  ].filter(Boolean);
  const text = lines.join("\n");
  const html = `<div style="font-family:Arial,sans-serif;line-height:1.55;color:#111827">
    <h2 style="margin:0 0 12px;color:#111827">Quote request received</h2>
    <p>Hi ${htmlEsc(name || "there")},</p>
    <p>Done. One Kind Express has your quote request and contact details. Our team will review the shipment and follow up with next steps.</p>
    <div style="border:1px solid #e5e7eb;border-radius:12px;padding:14px;background:#f9fafb">
      ${payload.quote_ref ? `<p><b>Quote:</b> ${htmlEsc(payload.quote_ref)}</p>` : ""}
      ${payload.origin || payload.destination ? `<p><b>Lane:</b> ${htmlEsc(payload.origin || "-")} -> ${htmlEsc(payload.destination || "-")}</p>` : ""}
      ${payload.total ? `<p><b>Quoted total:</b> $${Number(payload.total).toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>` : ""}
      ${payload.share_url ? `<p><a href="${htmlEsc(payload.share_url)}">Open quote</a></p>` : ""}
    </div>
    <p style="color:#6b7280;font-size:13px">One Kind Express</p>
  </div>`;

  const attempt = await sendResend(email, subject, html, text) || await sendBrevo(email, subject, html, text);
  if (!attempt) return json({ ok: false, error: "No email provider configured. Set RESEND_API_KEY or BREVO_API_KEY." }, 500);
  if (!attempt.res.ok) return json({ ok: false, provider: attempt.provider, status: attempt.res.status, detail: await attempt.res.text().catch(() => "") }, 502);
  return json({ ok: true, provider: attempt.provider });
});
