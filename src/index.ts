import express, { Request, Response, NextFunction } from "express";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

/** ENV */
const PORT = Number(process.env.PORT || 8080);
const API_KEY = process.env.API_GATEWAY_KEY || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE || "";

/** Clients */
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE);

/** Helpers */
const CP_REGEX = /\b\d{5}\b/;
const nowIso = () => new Date().toISOString();

type InBody = {
  lead_id: string;
  address: string;
  square_meters?: number;
  postal_code?: string;
};
type Source = "cached" | "openai" | "mitma" | "na";

/** DB: cache por CP */
async function getCachedPrice(cp: string): Promise<number | null> {
  const { data, error } = await sb
    .from("price_m2_cache")
    .select("price_m2, fresh_until")
    .eq("cp", cp)
    .maybeSingle();

  if (error || !data) return null;
  const fresh = data.fresh_until ? new Date(String(data.fresh_until)).getTime() : 0;
  if (!fresh || fresh <= Date.now()) return null;
  return Number(data.price_m2);
}

async function upsertCache(cp: string, price: number, source: Source = "openai", ttlDays = 90) {
  await sb.from("price_m2_cache").upsert({
    cp,
    price_m2: price,
    source,
    fetched_at: nowIso(),
    ttl_days: ttlDays
  });
}

async function updateLeadRow(
  lead_id: string,
  price_m2: number | null,
  valuation_price: number | null,
  source: Source,
  confidence: number
) {
  await sb
    .from("leads")
    .update({
      price_m2,
      valuation_price,
      valuation_source: source,
      valuation_confidence: confidence,
      valuation_at: nowIso()
    })
    .eq("id", lead_id);
}

/** OpenAI provider – Chat Completions robusto con JSON forzado y reintento por CP */
async function fetchPriceM2WithOpenAI(address: string, cp: string): Promise<number | null> {
  if (!OPENAI_API_KEY) return null;

  const sys = `Eres un extractor de datos inmobiliarios en España.
Devuelve SIEMPRE JSON válido. Si no tienes un dato fiable, devuelve {"na": true}.
Cuando tengas dato, devuelve {"price_m2_eur_int": <entero>} con el precio medio de venta por m² (euros/m²). 
No incluyas texto ni unidades, solo el JSON.`;

  const prompts = [
    `Dame el precio medio de venta por m² de vivienda para esta dirección: "${address}" (España). 
Si hay dato fiable, responde {"price_m2_eur_int": N}. Si no, responde {"na": true}.`,
    `Dame el precio medio de venta por m² de vivienda para el código postal ${cp} (España).
Si hay dato fiable, responde {"price_m2_eur_int": N}. Si no, responde {"na": true}.`
  ];

  for (const p of prompts) {
    const r = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      temperature: 0,
      max_tokens: 60,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: p }
      ],
    });

    const raw = r?.choices?.[0]?.message?.content ?? "";
    try {
      const obj = JSON.parse(raw);
      if (obj?.price_m2_eur_int && Number.isInteger(obj.price_m2_eur_int)) {
        return obj.price_m2_eur_int as number;
      }
    } catch {
      continue;
    }
  }
  return null;
}

/** App */
const app = express();
app.use(express.json());

// Auth desactivada temporalmente para pruebas
app.use((_req: Request, _res: Response, next: NextFunction) => next());

app.post("/valuation/v1/price-m2", async (req: Request, res: Response) => {
  try {
    const body = req.body as InBody;
    if (!body?.lead_id || !body?.address) {
      return res.status(400).json({ error: "lead_id y address son obligatorios" });
    }

    const cp = body.postal_code || (body.address.match(CP_REGEX)?.[0] ?? "").trim();
    if (!cp) return res.status(400).json({ error: "no se pudo detectar el CP" });

    // 1) cache
    let price: number | null = await getCachedPrice(cp);
    let source: Source = price ? "cached" : "na";

    // 2) OpenAI si no hay cache fresca
    if (!price) {
      price = await fetchPriceM2WithOpenAI(body.address, cp);
      if (price) {
        source = "openai";
        await upsertCache(cp, price, source, 90);
      }
    }

    const valuation_price =
      price && body.square_meters ? Math.round(price * body.square_meters) : null;

    const confidence = price ? (source === "openai" || source === "cached" ? 85 : 60) : 0;

    await updateLeadRow(body.lead_id, price ?? null, valuation_price, source, confidence);

    return res.json({
      lead_id: body.lead_id,
      price_m2: price,
      valuation_price,
      source,
      confidence,
      valuation_at: nowIso()
    });
  } catch (e) {
    console.error("[/valuation/v1/price-m2] error:", e);
    return res.status(500).json({ error: "internal_error" });
  }
});

app.get("/health", (_req: Request, res: Response) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`valuation service on :${PORT}`);
});
