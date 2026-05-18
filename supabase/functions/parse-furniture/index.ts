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

const itemSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    items: {
      type: "array",
      maxItems: 24,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          itemType: { type: "string" },
          qty: { type: "integer", minimum: 1, maximum: 99 },
          lengthIn: { type: "integer", minimum: 1, maximum: 300 },
          widthIn: { type: "integer", minimum: 1, maximum: 180 },
          heightIn: { type: "integer", minimum: 1, maximum: 180 },
          weightLb: { type: "integer", minimum: 1, maximum: 3000 },
          confidence: { type: "string", enum: ["high", "medium", "low"] },
          notes: { type: "string" },
        },
        required: ["name", "itemType", "qty", "lengthIn", "widthIn", "heightIn", "weightLb", "confidence", "notes"],
      },
    },
  },
  required: ["summary", "items"],
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
    confidence: (["high", "medium", "low"].includes(conf) ? conf : "medium") as ParsedItem["confidence"],
    notes: String(raw.notes || "estimated from image").slice(0, 180),
  };
}

function parseOpenAIResponse(data: Record<string, unknown>) {
  const outputText = typeof data.output_text === "string"
    ? data.output_text
    : Array.isArray(data.output)
      ? data.output.flatMap((o: any) => Array.isArray(o.content) ? o.content : [])
          .filter((c: any) => c.type === "output_text")
          .map((c: any) => c.text || "")
          .join("\n")
      : "";
  if (!outputText) throw new Error("OpenAI returned no output text");
  const parsed = JSON.parse(outputText);
  const items = Array.isArray(parsed.items) ? parsed.items.map(cleanItem).slice(0, 24) : [];
  return {
    summary: String(parsed.summary || `Identified ${items.length} shippable item${items.length === 1 ? "" : "s"}.`).slice(0, 240),
    items,
  };
}

async function callOpenAI(model: string, imageParts: unknown[]) {
  const key = Deno.env.get("OPENAI_API_KEY");
  if (!key) throw new Error("OPENAI_API_KEY is not configured in Supabase Edge Function secrets");
  const body = {
    model,
    input: [
      {
        role: "developer",
        content: [{
          type: "input_text",
          text: "You are a final-mile freight quoting assistant. Return only schema-valid JSON. Estimate packaged shipping dimensions in inches and shipping weight in pounds. Identify every visible shippable furniture/product item, including beds, sofas, chairs, TVs, tables, cabinets, rugs, appliances, boxes, crates, and pallets. Ignore people, walls, floors, and decorative items unless they are being shipped. If scale is uncertain, provide a conservative freight estimate and confidence low or medium.",
        }],
      },
      {
        role: "user",
        content: [
          { type: "input_text", text: "Analyze these image(s) for freight quote item capture. Return item rows that can be dropped into a calculator." },
          ...imageParts,
        ],
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "furniture_quote_items",
        strict: true,
        schema: itemSchema,
      },
    },
  };
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  if (!res.ok) {
    let detail = raw;
    try { detail = JSON.parse(raw)?.error?.message || raw; } catch (_) {}
    throw new Error(`${model}: ${res.status} ${detail}`);
  }
  return { ...parseOpenAIResponse(JSON.parse(raw)), model };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  try {
    const body = await req.json().catch(() => ({}));
    const images = Array.isArray(body.images) ? body.images.slice(0, 8) : [];
    const parts = images.map(imagePart).filter(Boolean);
    if (!parts.length) return json({ summary: "No image data received.", items: [] });

    const configured = Deno.env.get("OPENAI_VISION_MODEL");
    const models = [
      configured,
      "gpt-5.4-mini",
      "gpt-5.4",
      "gpt-5.4-nano",
    ].filter((v, i, arr): v is string => !!v && arr.indexOf(v) === i);

    const errors: string[] = [];
    for (const model of models) {
      try {
        return json(await callOpenAI(model, parts));
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }

    return json({
      summary: "Photo analysis is temporarily unavailable. Added a conservative starter item you can edit.",
      items: [{
        name: "Mixed furniture item",
        itemType: "Mixed furniture",
        qty: 1,
        lengthIn: 60,
        widthIn: 30,
        heightIn: 30,
        weightLb: 100,
        confidence: "low",
        notes: "Review and edit this estimate before quoting.",
      }],
      fallback: true,
    });
  } catch (e) {
    return json({ error: "parse_failed", detail: e instanceof Error ? e.message : String(e) }, 500);
  }
});
