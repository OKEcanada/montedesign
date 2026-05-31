const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type MailPayload = Record<string, unknown> & {
  recipient_type?: string;
  quote_ref?: string;
  origin?: string;
  destination?: string;
  total?: string | number;
  customer?: string;
  customer_email?: string;
  customer_phone?: string;
  email?: string;
  phone?: string;
  notes?: string;
  requested_at?: string;
  pickup_date?: string;
  share_url?: string;
  booking_summary?: string;
  booking_email_body?: string;
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });
}

function htmlEsc(v: unknown) {
  return String(v ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!)
  );
}

function text(v: unknown) {
  return String(v ?? "").trim();
}

function formatMoney(v: unknown) {
  if (typeof v === "string" && v.trim().startsWith("$")) return v.trim();
  const n = Number(v);
  if (!Number.isFinite(n)) return text(v) || "-";
  return "$" + n.toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function parseSender() {
  const from = Deno.env.get("EMAIL_FROM") || Deno.env.get("MAIL_FROM") || "";
  const match = from.match(/^(.*?)\s*<([^>]+)>$/);
  if (match) return { name: match[1].trim() || "One Kind Express", email: match[2].trim() };
  return {
    name: Deno.env.get("MAIL_SENDER_NAME") || "One Kind Express",
    email: Deno.env.get("MAIL_SENDER_EMAIL") || from || "info@onekindexpress.com",
  };
}

function replyToEmail() {
  const replyTo = Deno.env.get("REPLY_TO") || Deno.env.get("MAIL_REPLY_TO") || "info@onekindexpress.com";
  const match = replyTo.match(/<([^>]+)>/);
  return (match ? match[1] : replyTo).trim();
}

function bookingNotifyTo() {
  return Deno.env.get("BOOKING_NOTIFY_TO") || Deno.env.get("OKE_NOTIFY_EMAIL") || "info@onekindexpress.com";
}

function quoteLane(payload: MailPayload) {
  const origin = text(payload.origin);
  const destination = text(payload.destination);
  return origin || destination ? `${origin || "-"} -> ${destination || "-"}` : "-";
}

function formatDateTime(v: unknown) {
  const raw = text(v);
  if (!raw) return "";
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  return d.toLocaleString("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDate(v: unknown) {
  const raw = text(v);
  if (!raw) return "";
  const d = new Date(`${raw}T12:00:00`);
  if (Number.isNaN(d.getTime())) return raw;
  return d.toLocaleDateString("en-CA", { year: "numeric", month: "short", day: "2-digit" });
}

function line(label: string, value: unknown) {
  const v = text(value);
  return v ? `${label}: ${v}` : "";
}

function htmlRow(label: string, value: unknown) {
  const v = text(value);
  if (!v) return "";
  return `<tr><td style="padding:7px 10px;color:#6b7280;width:145px">${htmlEsc(label)}</td><td style="padding:7px 10px;color:#111827;font-weight:700">${htmlEsc(v)}</td></tr>`;
}

function emailShell(title: string, intro: string, rows: string, extraHtml = "") {
  return `<div style="font-family:Arial,Helvetica,sans-serif;line-height:1.55;color:#111827;background:#f5f2ea;padding:24px">
    <div style="max-width:680px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:16px;overflow:hidden">
      <div style="background:#080d25;color:#ffffff;padding:18px 22px">
        <div style="font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:#ff9b6b;font-weight:800">One Kind Express</div>
        <h1 style="margin:8px 0 0;font-size:24px;line-height:1.2">${htmlEsc(title)}</h1>
      </div>
      <div style="padding:22px">
        <p style="margin:0 0 16px;color:#374151">${htmlEsc(intro)}</p>
        <table style="width:100%;border-collapse:collapse;background:#f9fafb;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden">${rows}</table>
        ${extraHtml}
        <p style="margin:20px 0 0;color:#6b7280;font-size:13px">One Kind Express<br>info@onekindexpress.com | 1-833-653-5777</p>
      </div>
    </div>
  </div>`;
}

function buildInternalEmail(payload: MailPayload) {
  const quote = text(payload.quote_ref) || "New quote";
  const customerEmail = text(payload.customer_email || payload.email);
  const customerPhone = text(payload.customer_phone || payload.phone);
  const customerName = text(payload.customer) || "Customer";
  const rows = [
    htmlRow("Quote", quote),
    htmlRow("Requested", formatDateTime(payload.requested_at)),
    htmlRow("Preferred pickup", formatDate(payload.pickup_date)),
    htmlRow("Customer", customerName),
    htmlRow("Email", customerEmail),
    htmlRow("Phone", customerPhone),
    htmlRow("Lane", quoteLane(payload)),
    htmlRow("Total", payload.total ? formatMoney(payload.total) : ""),
    htmlRow("Notes", payload.notes),
  ].join("");
  const quoteBody = text(payload.booking_email_body || payload.booking_summary);
  const extra = [
    payload.share_url
      ? `<p style="margin:18px 0"><a style="display:inline-block;background:#ff6b3a;color:#fff;text-decoration:none;padding:12px 16px;border-radius:10px;font-weight:800" href="${htmlEsc(payload.share_url)}">Open saved quote</a></p>`
      : "",
    quoteBody
      ? `<div style="margin-top:18px"><div style="font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#6b7280;font-weight:800;margin-bottom:8px">Quote details</div><pre style="white-space:pre-wrap;margin:0;background:#111827;color:#f9fafb;border-radius:12px;padding:14px;font-family:Consolas,monospace;font-size:12px;line-height:1.55">${htmlEsc(quoteBody)}</pre></div>`
      : "",
  ].join("");
  const subject = `New booking request ${quote} - ${quoteLane(payload)}`;
  const plain = [
    "New One Kind Express booking request",
    "",
    line("Quote", quote),
    line("Requested", formatDateTime(payload.requested_at)),
    line("Preferred pickup", formatDate(payload.pickup_date)),
    line("Customer", customerName),
    line("Email", customerEmail),
    line("Phone", customerPhone),
    line("Lane", quoteLane(payload)),
    payload.total ? line("Total", formatMoney(payload.total)) : "",
    line("Notes", payload.notes),
    payload.share_url ? line("Quote link", payload.share_url) : "",
    quoteBody ? `\nQUOTE DETAILS\n${quoteBody}` : "",
  ].filter(Boolean).join("\n");
  return {
    subject,
    text: plain,
    html: emailShell("New booking request", "A customer requested this quote from the national calculator.", rows, extra),
  };
}

function buildCustomerEmail(name: string, payload: MailPayload) {
  const quote = text(payload.quote_ref) || "your quote";
  const rows = [
    htmlRow("Quote", quote),
    htmlRow("Preferred pickup", formatDate(payload.pickup_date)),
    htmlRow("Lane", quoteLane(payload)),
    htmlRow("Total", payload.total ? formatMoney(payload.total) : ""),
  ].join("");
  const quoteBody = text(payload.booking_email_body || payload.booking_summary);
  const extra = [
    payload.share_url
      ? `<p style="margin:18px 0"><a style="display:inline-block;background:#ff6b3a;color:#fff;text-decoration:none;padding:12px 16px;border-radius:10px;font-weight:800" href="${htmlEsc(payload.share_url)}">Open your quote</a></p>`
      : "",
    quoteBody
      ? `<div style="margin-top:18px"><div style="font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#6b7280;font-weight:800;margin-bottom:8px">Quote details and pricing</div><pre style="white-space:pre-wrap;margin:0;background:#f9fafb;color:#111827;border:1px solid #e5e7eb;border-radius:12px;padding:14px;font-family:Consolas,monospace;font-size:12px;line-height:1.55">${htmlEsc(quoteBody)}</pre></div>`
      : "",
  ].join("");
  const subject = `One Kind Express received your booking request ${quote}`;
  const plain = [
    `Hi ${name || "there"},`,
    "",
    "We received your booking request. Our team will review the shipment details and follow up with next steps.",
    "",
    line("Quote", quote),
    line("Preferred pickup", formatDate(payload.pickup_date)),
    line("Lane", quoteLane(payload)),
    payload.total ? line("Total", formatMoney(payload.total)) : "",
    payload.share_url ? line("Quote link", payload.share_url) : "",
    quoteBody ? `\nQUOTE DETAILS AND PRICING\n${quoteBody}` : "",
    "",
    "One Kind Express",
    "info@onekindexpress.com | 1-833-653-5777",
  ].filter(Boolean).join("\n");
  return {
    subject,
    text: plain,
    html: emailShell(
      "Booking request received",
      `Hi ${name || "there"}, we received your booking request. Our team will review the shipment details and follow up with next steps.`,
      rows,
      extra,
    ),
  };
}

async function sendBrevo(to: string, subject: string, html: string, plain: string) {
  const key = Deno.env.get("BREVO_API_KEY");
  if (!key) return null;
  const sender = parseSender();
  const replyTo = replyToEmail();
  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: { "content-type": "application/json", "api-key": key },
    body: JSON.stringify({
      sender,
      to: [{ email: to }],
      replyTo: { email: replyTo },
      subject,
      htmlContent: html,
      textContent: plain,
    }),
  });
  return { provider: "brevo", res };
}

async function sendResend(to: string, subject: string, html: string, plain: string) {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) return null;
  const sender = parseSender();
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ from: `${sender.name} <${sender.email}>`, to: [to], reply_to: replyToEmail(), subject, html, text: plain }),
  });
  return { provider: "resend", res };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  const body = await req.json().catch(() => ({}));
  const payload = (body.payload || {}) as MailPayload;
  const recipientType = text(payload.recipient_type || body.recipient_type).toLowerCase();
  const isInternal = recipientType === "internal";
  const to = isInternal
    ? bookingNotifyTo()
    : text(body.email || body.to || payload.email || payload.customer_email);
  const name = text(body.name || payload.customer || "there");

  if (!to || !to.includes("@")) return json({ ok: false, error: "recipient email required" }, 400);

  const email = isInternal ? buildInternalEmail(payload) : buildCustomerEmail(name, payload);
  const attempt = await sendBrevo(to, email.subject, email.html, email.text) || await sendResend(to, email.subject, email.html, email.text);
  if (!attempt) return json({ ok: false, error: "No email provider configured. Set BREVO_API_KEY or RESEND_API_KEY." }, 500);

  const providerText = await attempt.res.text().catch(() => "");
  let providerJson: Record<string, unknown> | null = null;
  try { providerJson = providerText ? JSON.parse(providerText) : null; } catch (_) {}
  if (!attempt.res.ok) {
    return json({ ok: false, provider: attempt.provider, status: attempt.res.status, detail: providerJson || providerText }, 502);
  }

  return json({
    ok: true,
    provider: attempt.provider,
    recipient_type: isInternal ? "internal" : "customer",
    message_id: providerJson?.messageId || providerJson?.id || null,
  });
});
