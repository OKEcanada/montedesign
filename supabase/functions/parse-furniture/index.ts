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
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "content-type": "application/json" },
  });
}

function imagePart(dataUrl: string) {
  if (!/^data:image\/[a-z0-9.+-]+;base64,/i.test(String(dataUrl || ""))) return null;
  return { type: "input_image", image_url: dataUrl, detail: "high" };
}

function clampNum(v: unknown, fallback: number, min = 1, max = 999) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function cleanItem(raw: Record<string, unknown>): ParsedItem {
  const name = String(raw.name || raw.itemType || "Furniture item").slice(0, 80);
  const itemType = String(raw.itemType || raw.name || "Mixed furniture").slice(0, 80);
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
    notes: String(raw.notes || "estimated from image").slice(0, 180),
  };
}

const SYSTEM_PROMPT = `You are a SHIPPING DIMENSIONS expert for OKE Canada Freight final-mile delivery.
Return ONLY valid JSON in the form {"summary":string,"items":[{name,itemType,qty,lengthIn,widthIn,heightIn,weightLb,confidence,notes}, ...]}. Identify EVERY visible shippable item.

RULES:
1. Be SPECIFIC: "3-seat fabric sofa", "queen mattress", "6-drawer oak dresser", "55-inch flat screen TV". NEVER generic terms like "furniture" or "item".
2. Estimate PACKAGED shipping dimensions in INCHES and SHIPPING WEIGHT in POUNDS (add ~4 inches per dim for boxing/crating; mattresses use compression-bag dims).
3. Realistic weights: 3-seat sofa 90-150 lb, queen mattress 70-120 lb, 6-drawer dresser 110-180 lb, 55" TV (boxed) 55-75 lb, washer/dryer 180-250 lb, fridge 200-400 lb, dining table 90-160 lb, dining chair 15-30 lb.
4. confidence: "high" when clearly identifiable, "medium" when partial/blurry, "low" when guessing.
5. NEVER invent items. If unclear, return empty items with explanation in summary.
6. summary: one short line describing what's in the photo.`;

function quotaError(detail: string) {
  return /quota|billing|insufficient_quota|exceeded/i.test(detail);
}

function modelMissing(detail: string) {
  return /model:.*does not exist|model_not_found|404/i.test(detail);
}

async function callOpenAIVision(model: string, imageParts: unknown[]) {
  const key = Deno.env.get("OPENAI_API_KEY");
  if (!key) throw new Error("OPENAI_API_KEY is not configured in Supabase Edge Function secrets");

  // Use the classic /v1/chat/completions endpoint — most reliable for vision.
  const userContent: any[] = [
    { type: "text", text: "Analyze these image(s) for freight quote item capture. Identify every shippable item, give specific names, and return packaged shipping dims + weight as JSON." },
  ];
  for (const part of imageParts as any[]) {
    if (part && part.image_url) {
      userContent.push({ type: "image_url", image_url: { url: part.image_url, detail: "high" } });
    }
  }
  const chatBody = {
    model,
    max_tokens: 2048,
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
  const items = Array.isArray(parsed.items) ? parsed.items.map(cleanItem).slice(0, 24) : [];
  return {
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
    const images = Array.isArray(body.images) ? body.images.slice(0, 8) : [];
    const parts = images.map(imagePart).filter(Boolean);
    if (!parts.length) return json({ summary: "No image data received.", items: [] });

    // Use ONLY real OpenAI vision-capable models. Filter out any garbage env var values.
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
      ? "OpenAI account quota exceeded — the AI photo identifier is paused until billing is updated. Edit the starter item below."
      : `Photo analysis failed: ${errors[0] || "no models reachable"}. Edit the starter item below.`;

    return json({
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
        notes: sawQuota ? "AI paused (OpenAI quota). Edit dims and weight." : "AI fallback — review and edit before quoting.",
      }],
      fallback: true,
      quota_exceeded: sawQuota,
      errors,
    });
  } catch (e) {
    return json({ error: "parse_failed", detail: e instanceof Error ? e.message : String(e) }, 500);
  }
});
