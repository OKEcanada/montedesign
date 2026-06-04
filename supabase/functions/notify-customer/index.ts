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
  company?: string;
  pickup_address?: string;
  delivery_address?: string;
  requested_window?: string;
  po_number?: string;
  action?: string;
  notes?: string;
  requested_at?: string;
  pickup_date?: string;
  share_url?: string;
  public_token?: string;
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
  return `<tr><td style="padding:10px 12px;color:#747b91;width:156px;font-size:12px;text-transform:uppercase;letter-spacing:.08em;font-weight:800;vertical-align:top">${htmlEsc(label)}</td><td style="padding:10px 12px;color:#111827;font-weight:800;white-space:pre-line">${htmlEsc(v)}</td></tr>`;
}

function isChangeRequest(payload: MailPayload) {
  const action = text(payload.action).toLowerCase();
  return action.includes("change") || action.includes("revision");
}

function requestKind(payload: MailPayload) {
  return isChangeRequest(payload) ? "Change request" : "Booking request";
}

function savedQuoteUrl(payload: MailPayload) {
  const directToken = text(payload.public_token);
  if (directToken) return `https://quote.onekindexpress.com/?token=${encodeURIComponent(directToken)}`;
  const raw = text(payload.share_url);
  if (!raw) return "";
  try {
    const url = new URL(raw);
    const token = url.searchParams.get("token") || url.searchParams.get("quote");
    if (token) return `https://quote.onekindexpress.com/?token=${encodeURIComponent(token)}`;
  } catch (_) {
    const match = raw.match(/[?&](?:token|quote)=([^&#]+)/i);
    if (match && match[1]) return `https://quote.onekindexpress.com/?token=${encodeURIComponent(decodeURIComponent(match[1]))}`;
  }
  return raw;
}

function ctaButton(label: string, href: unknown) {
  const url = text(href);
  if (!url) return "";
  return `<p style="margin:20px 0 8px"><a style="display:inline-block;background:linear-gradient(135deg,#ff7a45,#f04418);color:#fff;text-decoration:none;padding:14px 18px;border-radius:999px;font-weight:900;box-shadow:0 12px 28px rgba(255,122,69,.28)" href="${htmlEsc(url)}">${htmlEsc(label)}</a></p>`;
}

function infoBox(title: string, body: string) {
  return `<div style="margin-top:18px;border:1px solid #ffd3be;background:#fff7f1;border-radius:16px;padding:14px 16px">
    <div style="font-size:12px;text-transform:uppercase;letter-spacing:.12em;color:#f04418;font-weight:900;margin-bottom:5px">${htmlEsc(title)}</div>
    <div style="color:#374151;font-size:14px">${htmlEsc(body)}</div>
  </div>`;
}

function emailShell(title: string, intro: string, rows: string, extraHtml = "") {
  return `<div style="font-family:Arial,Helvetica,sans-serif;line-height:1.55;color:#111827;background:#05060d;padding:28px">
    <div style="max-width:720px;margin:0 auto;background:#fbfaf6;border:1px solid #e7dfd2;border-radius:22px;overflow:hidden;box-shadow:0 24px 70px rgba(0,0,0,.28)">
      <div style="background:linear-gradient(135deg,#07091a,#111827 58%,#30140b);color:#ffffff;padding:22px 24px">
        <div style="display:inline-flex;align-items:center;gap:9px;background:rgba(255,122,69,.12);border:1px solid rgba(255,122,69,.35);border-radius:999px;padding:7px 10px">
          <span style="display:inline-block;width:9px;height:9px;border-radius:999px;background:#ff7a45;box-shadow:0 0 16px #ff7a45"></span>
          <span style="font-size:12px;letter-spacing:.16em;text-transform:uppercase;color:#ffad7a;font-weight:900">One Kind Express</span>
        </div>
        <h1 style="margin:9px 0 0;font-size:28px;line-height:1.08;letter-spacing:-.03em">${htmlEsc(title)}</h1>
      </div>
      <div style="padding:24px">
        <p style="margin:0 0 18px;color:#374151;font-size:15px">${htmlEsc(intro)}</p>
        <table style="width:100%;border-collapse:collapse;background:#ffffff;border:1px solid #e5e7eb;border-radius:14px;overflow:hidden">${rows}</table>
        ${extraHtml}
        <p style="margin:22px 0 0;color:#6b7280;font-size:13px">One Kind Express<br>info@onekindexpress.com | 1-833-653-5777</p>
      </div>
    </div>
  </div>`;
}

function buildInternalEmail(payload: MailPayload) {
  const quote = text(payload.quote_ref) || "New quote";
  const isChange = isChangeRequest(payload);
  const quoteUrl = savedQuoteUrl(payload);
  const customerEmail = text(payload.customer_email || payload.email);
  const customerPhone = text(payload.customer_phone || payload.phone);
  const customerName = text(payload.customer) || "Customer";
  const rows = [
    htmlRow("Request type", requestKind(payload)),
    htmlRow("Quote", quote),
    htmlRow("Requested", formatDateTime(payload.requested_at)),
    htmlRow("Preferred pickup", formatDate(payload.pickup_date)),
    htmlRow("Customer", customerName),
    htmlRow("Company", payload.company),
    htmlRow("Email", customerEmail),
    htmlRow("Phone", customerPhone),
    htmlRow("Lane", quoteLane(payload)),
    htmlRow("Pickup address", payload.pickup_address),
    htmlRow("Delivery address", payload.delivery_address),
    htmlRow("Preferred window", payload.requested_window),
    htmlRow("PO / reference", payload.po_number),
    htmlRow("Total", payload.total ? formatMoney(payload.total) : ""),
    htmlRow("Notes", payload.notes),
  ].join("");
  const quoteBody = text(payload.booking_email_body || payload.booking_summary);
  const extra = [
    ctaButton("Open saved quote page", quoteUrl),
    infoBox(
      isChange ? "Internal next step" : "Internal next step",
      isChange
        ? "Review the customer note, open the saved quote, and follow up with the corrected details or next question."
        : "Review the quote, addresses, access notes, timing, and selected services before dispatch confirmation."
    ),
    quoteBody
      ? `<div style="margin-top:18px"><div style="font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#6b7280;font-weight:800;margin-bottom:8px">Quote details</div><pre style="white-space:pre-wrap;margin:0;background:#111827;color:#f9fafb;border-radius:12px;padding:14px;font-family:Consolas,monospace;font-size:12px;line-height:1.55">${htmlEsc(quoteBody)}</pre></div>`
      : "",
  ].join("");
  const subject = `${isChange ? "Quote change request" : "New booking request"} ${quote} - ${quoteLane(payload)}`;
  const plain = [
    `New One Kind Express ${isChange ? "change request" : "booking request"}`,
    "",
    line("Request type", requestKind(payload)),
    line("Quote", quote),
    line("Requested", formatDateTime(payload.requested_at)),
    line("Preferred pickup", formatDate(payload.pickup_date)),
    line("Customer", customerName),
    line("Company", payload.company),
    line("Email", customerEmail),
    line("Phone", customerPhone),
    line("Lane", quoteLane(payload)),
    line("Pickup address", payload.pickup_address),
    line("Delivery address", payload.delivery_address),
    line("Preferred window", payload.requested_window),
    line("PO / reference", payload.po_number),
    payload.total ? line("Total", formatMoney(payload.total)) : "",
    line("Notes", payload.notes),
    quoteUrl ? line("Quote link", quoteUrl) : "",
    quoteBody ? `\nQUOTE DETAILS\n${quoteBody}` : "",
  ].filter(Boolean).join("\n");
  return {
    subject,
    text: plain,
    html: emailShell(
      isChange ? "Quote change request" : "New booking request",
      isChange
        ? "A customer requested changes to this saved quote. Open the quote page, review the notes, and reopen the calculator from that page if edits are needed."
        : "A customer requested this quote. Open the saved quote page first, then use the calculator button there if edits are needed.",
      rows,
      extra,
    ),
  };
}

function buildCustomerEmail(name: string, payload: MailPayload) {
  const quote = text(payload.quote_ref) || "your quote";
  const isChange = isChangeRequest(payload);
  const quoteUrl = savedQuoteUrl(payload);
  const rows = [
    htmlRow("Request type", requestKind(payload)),
    htmlRow("Quote", quote),
    htmlRow("Preferred pickup", formatDate(payload.pickup_date)),
    htmlRow("Lane", quoteLane(payload)),
    htmlRow("Pickup address", payload.pickup_address),
    htmlRow("Delivery address", payload.delivery_address),
    htmlRow("Preferred window", payload.requested_window),
    htmlRow("PO / reference", payload.po_number),
    htmlRow("Total", payload.total ? formatMoney(payload.total) : ""),
    htmlRow("Notes", payload.notes),
  ].join("");
  const quoteBody = text(payload.booking_email_body || payload.booking_summary);
  const extra = [
    ctaButton("View your saved quote", quoteUrl),
    quoteUrl ? `<p style="margin:0 0 18px;color:#6b7280;font-size:13px">This opens your saved quote page first. From there you can copy details, print, request changes, or open the same quote in the calculator.</p>` : "",
    infoBox(
      isChange ? "What happens next" : "What happens next",
      isChange
        ? "Your requested change was sent to One Kind Express. We will review the note and quote details, then follow up with an update."
        : "Your booking request was sent to One Kind Express. We will review addresses, access notes, timing, and capacity before dispatch confirmation."
    ),
    quoteBody
      ? `<div style="margin-top:18px"><div style="font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#6b7280;font-weight:800;margin-bottom:8px">Quote details and pricing</div><pre style="white-space:pre-wrap;margin:0;background:#f9fafb;color:#111827;border:1px solid #e5e7eb;border-radius:12px;padding:14px;font-family:Consolas,monospace;font-size:12px;line-height:1.55">${htmlEsc(quoteBody)}</pre></div>`
      : "",
  ].join("");
  const subject = isChange
    ? `Change request received - ${quote}`
    : `Booking request received - ${quote}`;
  const plain = [
    `Hi ${name || "there"},`,
    "",
    isChange
      ? "We received your requested changes. One Kind Express will review the note and quote details, then follow up with the next step."
      : "We received your booking request. One Kind Express will review the addresses, access notes, timing, and capacity before dispatch confirmation.",
    "",
    line("Request type", requestKind(payload)),
    line("Quote", quote),
    line("Preferred pickup", formatDate(payload.pickup_date)),
    line("Lane", quoteLane(payload)),
    line("Pickup address", payload.pickup_address),
    line("Delivery address", payload.delivery_address),
    line("Preferred window", payload.requested_window),
    line("PO / reference", payload.po_number),
    line("Notes", payload.notes),
    payload.total ? line("Total", formatMoney(payload.total)) : "",
    quoteUrl ? line("Quote link", quoteUrl) : "",
    quoteBody ? `\nQUOTE DETAILS AND PRICING\n${quoteBody}` : "",
    "",
    "One Kind Express",
    "info@onekindexpress.com | 1-833-653-5777",
  ].filter(Boolean).join("\n");
  return {
    subject,
    text: plain,
    html: emailShell(
      isChange ? "Change request received" : "Booking request received",
      isChange
        ? `Hi ${name || "there"}, we received your requested changes. One Kind Express will review the quote and follow up with the next step.`
        : `Hi ${name || "there"}, we received your booking request. One Kind Express will review the addresses, access notes, timing, and capacity before dispatch confirmation.`,
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

async function deliverEmail(to: string, subject: string, html: string, plain: string) {
  const attempt = await sendBrevo(to, subject, html, plain) || await sendResend(to, subject, html, plain);
  if (!attempt) {
    return { ok: false, error: "No email provider configured. Set BREVO_API_KEY or RESEND_API_KEY." };
  }
  const providerText = await attempt.res.text().catch(() => "");
  let providerJson: Record<string, unknown> | null = null;
  try { providerJson = providerText ? JSON.parse(providerText) : null; } catch (_) {}
  if (!attempt.res.ok) {
    return {
      ok: false,
      provider: attempt.provider,
      status: attempt.res.status,
      detail: providerJson || providerText,
    };
  }
  return {
    ok: true,
    provider: attempt.provider,
    message_id: providerJson?.messageId || providerJson?.id || null,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);

  const body = await req.json().catch(() => ({}));
  const payload = { ...((body.payload || {}) as MailPayload) };
  if (!payload.action && body.event) payload.action = text(body.event);
  const recipientType = text(payload.recipient_type || body.recipient_type).toLowerCase();
  if (recipientType === "booking_pair") {
    const customerEmail = text(body.email || body.to || payload.email || payload.customer_email);
    const customerName = text(body.name || payload.customer || "there");
    const internalEmail = buildInternalEmail({ ...payload, recipient_type: "internal", customer_email: customerEmail });
    const internal = await deliverEmail(bookingNotifyTo(), internalEmail.subject, internalEmail.html, internalEmail.text);
    const customerEmailBody = buildCustomerEmail(customerName, payload);
    const customer = customerEmail && customerEmail.includes("@")
      ? await deliverEmail(customerEmail, customerEmailBody.subject, customerEmailBody.html, customerEmailBody.text)
      : { ok: false, skipped: true, error: "customer email missing" };
    return json({
      ok: !!internal.ok && (!!customer.ok || !!customer.skipped),
      recipient_type: "booking_pair",
      internal,
      customer,
    }, internal.ok ? 200 : 502);
  }
  const isInternal = recipientType === "internal";
  const to = isInternal
    ? bookingNotifyTo()
    : text(body.email || body.to || payload.email || payload.customer_email);
  const name = text(body.name || payload.customer || "there");

  if (!to || !to.includes("@")) return json({ ok: false, error: "recipient email required" }, 400);

  const email = isInternal ? buildInternalEmail(payload) : buildCustomerEmail(name, payload);
  const sent = await deliverEmail(to, email.subject, email.html, email.text);
  if (!sent.ok) return json(sent, sent.error && String(sent.error).includes("No email provider") ? 500 : 502);

  return json({
    ok: true,
    provider: sent.provider,
    recipient_type: isInternal ? "internal" : "customer",
    message_id: sent.message_id || null,
  });
});
