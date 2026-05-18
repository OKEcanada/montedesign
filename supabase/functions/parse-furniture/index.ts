const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type ParsedItem = {
  name: string;
  itemType: string;
  qty: number;
  lengthIn: number;
  widthIn: number;
  heightIn: number;
  weightLb: number;
  confidence: "high" | "medium" | "low";
  notes?: string;
  evidence?: string;
  explanation?: string;
  sourceIndex?: number;
};

type UploadFile = {
  dataUrl: string;
  filename?: string;
  mimeType?: string;
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}

function inputPart(file: UploadFile, index: number) {
  const dataUrl = String(file?.dataUrl || "");
  const filename = String(file?.filename || `upload-${index + 1}`);
  if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(dataUrl)) {
    return { type: "image_url", image_url: { url: dataUrl, detail: "high" } };
  }
  if (/^data:application\/pdf;base64,/i.test(dataUrl)) {
    return {
      type: "file",
      file: {
        filename: filename.toLowerCase().endsWith(".pdf") ? filename : `${filename}.pdf`,
        file_data: dataUrl,
      },
    };
  }
  return null;
}

function clampNum(v: unknown, fallback: number, min = 1, max = 999) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function cleanItem(raw: Record<string, unknown>): ParsedItem {
  const name = String(raw.name || raw.itemType || "Furniture item").slice(0, 80);
  let itemType = String(raw.itemType || raw.name || "Mixed furniture").slice(0, 80);
  if (/^(furniture|item|object|thing|mixed furniture|unknown)$/i.test(itemType.trim())) {
    itemType = name;
  }
  const conf = String(raw.confidence || "medium");
  return {
    name,
    itemType,
    qty: clampNum(raw.qty, 1, 1, 99),
    lengthIn: clampNum(raw.lengthIn, 48, 1, 300),
    widthIn: clampNum(raw.widthIn, 24, 1, 180),
    heightIn: clampNum(raw.heightIn, 24, 1, 180),
    weightLb: clampNum(raw.weightLb, 75, 1, 3000),
    confidence: ((["high", "medium", "low"].includes(conf) ? conf : "medium")) as ParsedItem["confidence"],
    notes: String(raw.notes || "estimated from upload").slice(0, 180),
    evidence: String(raw.evidence || "").slice(0, 220),
    explanation: String(raw.explanation || raw.reasoning || raw.notes || "").slice(0, 260),
    sourceIndex: clampNum(raw.sourceIndex, 0, 0, 99),
  };
}

const SYSTEM_PROMPT = `You are a SHIPPING DIMENSIONS expert for OKE Canada Freight final-mile delivery.
Return ONLY valid JSON in this form:
{"assistantMessage":string,"summary":string,"items":[{name,itemType,qty,lengthIn,widthIn,heightIn,weightLb,confidence,notes,evidence,explanation,sourceIndex}, ...]}.
Identify EVERY visible or listed shippable item from photos, screenshots, product labels, invoices, packing lists, and PDF order documents.

RULES:
1. Be SPECIFIC: "3-seat fabric sofa", "queen mattress", "6-drawer oak dresser", "55-inch flat screen TV". NEVER generic terms like "furniture" or "item".
2. itemType must be a usable quote category, not a broad class. Good itemType values: Sofa, Sectional, Lounge chair, Dining chair, Bed frame, Mattress, Dresser, Cabinet, Dining table, Coffee table, Desk, TV, Appliance, Mirror, Rug, Boxed item, Mixed furniture.
3. If actual dimensions, weight, quantity, SKU text, carton labels, or order-line details are visible, use that exact information and mention it in evidence.
4. If actual info is missing, estimate PACKAGED shipping dimensions in INCHES and SHIPPING WEIGHT in POUNDS. Add about 4 inches per dimension for boxing/crating when the item appears unpackaged. Mattresses can use compression-bag dimensions.
5. Group identical items into one row with qty > 1. Separate different products into separate rows. Examples: two identical dining chairs -> one Dining chair row qty 2; sofa + TV + two chairs -> three rows.
6. Realistic weights: 3-seat sofa 90-150 lb, queen mattress 70-120 lb, 6-drawer dresser 110-180 lb, 55" TV boxed 55-75 lb, washer/dryer 180-250 lb, fridge 200-400 lb, dining table 90-160 lb, dining chair 15-30 lb.
7. explanation must be a short customer-friendly reason for the dimensions/weight, e.g. "Used visible order label 84 x 38 x 36 in; added packaging allowance" or "Estimated packaged sofa at a normal 3-seat range because no label was visible."
8. evidence must quote or summarize the visible clue used, e.g. label text, SKU/order line, visible object, or "visual estimate only".
9. sourceIndex is the zero-based uploaded file index where the item came from.
10. confidence: "high" when clearly identifiable or label data is visible, "medium" when partial/blurry, "low" when guessing.
11. NEVER invent items. If unclear, return empty items with explanation in summary.
12. assistantMessage: one warm sentence explaining what you found and what you added to the quote.`;

function quotaError(detail: string) {
  return /quota|billing|insufficient_quota|exceeded/i.test(detail);
}

function modelMissing(detail: string) {
  return /model:.*does not exist|model_not_found|404/i.test(detail);
}

function mergeSimilarItems(items: ParsedItem[]) {
  const grouped = new Map<string, ParsedItem>();
  for (const item of items) {
    const key = [
      item.itemType.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(),
      item.lengthIn,
      item.widthIn,
      item.heightIn,
      item.weightLb,
    ].join("|");
    const prev = grouped.get(key);
    if (!prev) {
      grouped.set(key, { ...item });
      continue;
    }
    prev.qty += item.qty;
    prev.confidence = prev.confidence === "low" ? item.confidence : prev.confidence;
    prev.name = prev.name.length >= item.name.length ? prev.name : item.name;
    prev.evidence = [prev.evidence, item.evidence].filter(Boolean).join(" | ").slice(0, 220);
    prev.explanation = [prev.explanation, item.explanation].filter(Boolean).join(" | ").slice(0, 260);
    prev.notes = [prev.notes, item.notes].filter(Boolean).join(" | ").slice(0, 180);
  }
  return Array.from(grouped.values()).slice(0, 24);
}

async function callOpenAIVision(model: string, inputParts: unknown[]) {
  const key = Deno.env.get("OPENAI_API_KEY");
  if (!key) throw new Error("OPENAI_API_KEY is not configured in Supabase Edge Function secrets");

  const userContent: any[] = [
    {
      type: "text",
      text: "Analyze these upload(s) for freight quote item capture. They may be product photos, room photos, screenshots, labels, invoices, order PDFs, or packing lists. Identify every shippable item, group identical items, use exact label/order data when visible, estimate missing packaged dimensions and weight, and return only the requested JSON.",
    },
    ...(inputParts as any[]),
  ];
  const chatBody = {
    model,
    max_tokens: 3200,
    temperature: 0.1,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ],
  };
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(chatBody),
  });
  if (!res.ok) {
    let detail = await res.text();
    try { detail = JSON.parse(detail)?.error?.message || detail; } catch (_) {}
    const err = new Error(`${model}: ${res.status} ${String(detail).slice(0, 240)}`);
    (err as any).quota = quotaError(detail);
    (err as any).missing = modelMissing(detail);
    throw err;
  }
  const chat = JSON.parse(await res.text());
  const text = String(chat?.choices?.[0]?.message?.content || "").trim();
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  const jsonStr = (start >= 0 && end > start) ? cleaned.slice(start, end + 1) : cleaned;
  const parsed = JSON.parse(jsonStr);
  const items = mergeSimilarItems(Array.isArray(parsed.items) ? parsed.items.map(cleanItem) : []);
  return {
    assistantMessage: String(parsed.assistantMessage || parsed.message || parsed.summary || `I found ${items.length} shippable item${items.length === 1 ? "" : "s"} and drafted editable quote rows.`).slice(0, 360),
    summary: String(parsed.summary || `Identified ${items.length} shippable item${items.length === 1 ? "" : "s"}.`).slice(0, 240),
    items,
    model,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  try {
    const body = await req.json().catch(() => ({}));
    const uploads: UploadFile[] = [];
    if (Array.isArray(body.images)) {
      for (const dataUrl of body.images.slice(0, 8)) {
        uploads.push({ dataUrl: String(dataUrl || ""), filename: "image.jpg", mimeType: "image/jpeg" });
      }
    }
    if (Array.isArray(body.files)) {
      for (const f of body.files.slice(0, 8)) {
        uploads.push({
          dataUrl: String(f?.dataUrl || ""),
          filename: String(f?.name || f?.filename || "upload"),
          mimeType: String(f?.type || f?.mimeType || ""),
        });
      }
    }
    const parts = uploads.map(inputPart).filter(Boolean);
    if (!parts.length) {
      return json({
        assistantMessage: "I could not read that upload yet. Try an image or PDF order document.",
        summary: "No readable image or PDF data received.",
        items: [],
      });
    }

    const validModelPattern = /^gpt-(4o|4\.1|5|5-mini|4-turbo|4o-mini)/i;
    const configured = Deno.env.get("OPENAI_VISION_MODEL") || "";
    const candidates = [
      configured,
      "gpt-4o",
      "gpt-4o-mini",
      "gpt-4.1",
      "gpt-4.1-mini",
    ];
    const models = candidates.filter((v, i, arr): v is string => !!v && arr.indexOf(v) === i && validModelPattern.test(v));
    if (!models.length) models.push("gpt-4o");

    const errors: string[] = [];
    let sawQuota = false;
    for (const model of models) {
      try {
        return json(await callOpenAIVision(model, parts));
      } catch (e: any) {
        const msg = e instanceof Error ? e.message : String(e);
        errors.push(msg);
        if (e?.quota) { sawQuota = true; break; }
      }
    }

    const friendlyError = sawQuota
      ? "OpenAI account quota exceeded - the AI item identifier is paused until billing is updated. Edit the starter item below."
      : `Photo or PDF analysis failed: ${errors[0] || "no models reachable"}. Edit the starter item below.`;

    return json({
      assistantMessage: friendlyError,
      summary: friendlyError,
      items: [{
        name: "Mixed furniture item",
        itemType: "Mixed furniture",
        qty: 1,
        lengthIn: 60,
        widthIn: 30,
        heightIn: 30,
        weightLb: 100,
        confidence: "low",
        notes: sawQuota ? "AI paused (OpenAI quota). Edit dims and weight." : "AI fallback - review and edit before quoting.",
        evidence: "fallback",
        explanation: "I could not complete the analysis, so I added a conservative editable starter row.",
        sourceIndex: 0,
      }],
      fallback: true,
      quota_exceeded: sawQuota,
      errors,
    });
  } catch (e) {
    return json({ error: "parse_failed", detail: e instanceof Error ? e.message : String(e) }, 500);
  }
});
