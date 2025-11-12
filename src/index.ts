import express, { Request, Response, NextFunction } from "express";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

/** ENV */
const PORT = Number(process.env.PORT || 8080);
const API_KEY = process.env.API_GATEWAY_KEY || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

/** Clients */
const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

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

/** OpenAI provider – Chat Completions (estable) */
async function fetchPriceM2WithOpenAI(address: string): Promise<number | null> {
  if (!OPENAI_API_KEY) return null;

  const prompt = `Dime el precio promedio por metro cuadrado de venta de vivienda en ${address}.
Responde SOLO en este formato exacto: 6526 €/m². Si no hay datos, responde exactamente: NA.`;

  const r = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.1
  });

  const text = (r?.choices?.[0]?.message?.content ?? "").trim();
  if (!text) return null;

  const match = text.match(/(\d{3,6}(?:[.,]\d{1,3})?)/);
  if (!match || !match[1]) return null;

  const normalized = match[1].replace(/\./g, "").replace(",", ".");
  const n = Number(normalized);
  if (!Number.isFinite(n)) return null;

  return Math.round(n);
}

/** App */
const app = express();
app.use(express.json());

// Auth sencilla por header
app.use((req: Request, res: Response, next: NextFunction) => {
  if (!API_KEY || req.header("x-api-key") !== API_KEY) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
});

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
      price = await fetchPriceM2WithOpenAI(body.address);
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
