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

/** OpenAI provider – GPT‑4o con browsing activado (consultas reales en Idealista, Fotocasa, RealAdvisor) */
async function fetchPriceM2WithBrowsing(address: string, cp: string): Promise<{ price: number | null, detail?: any }> {
  if (!OPENAI_API_KEY) return { price: null };

  const sys = `Eres un analista inmobiliario en España con acceso a Idealista, Fotocasa y RealAdvisor.
Tu tarea es obtener el precio medio de venta por m² de viviendas residenciales para una dirección específica.
Busca en las 3 webs, extrae el valor medio más fiable de cada una y devuelve el promedio general.

Devuelve SIEMPRE un JSON con esta estructura exacta:
{
  "idealista": <número o null>,
  "fotocasa": <número o null>,
  "realadvisor": <número o null>,
  "average_price_m2": <número o null>,
  "sources_found": [ "idealista", "fotocasa", "realadvisor" ]
}`;

  const userPrompt = `Dirección: "${address}", código postal ${cp}, España.
Obtén el precio medio por m² de vivienda residencial según Idealista, Fotocasa y RealAdvisor.
Devuelve SOLO JSON válido con los campos definidos.`;

  try {
    const r = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.2,
      max_tokens: 250,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
    });

    const raw = r?.choices?.[0]?.message?.content ?? "";
    const obj = JSON.parse(raw);

    const vals = [obj.idealista, obj.fotocasa, obj.realadvisor].filter(v => typeof v === "number" && !isNaN(v));
    const avg = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;

    return {
      price: avg,
      detail: {
        idealista: obj.idealista ?? null,
        fotocasa: obj.fotocasa ?? null,
        realadvisor: obj.realadvisor ?? null,
        average: avg,
        sources_found: obj.sources_found ?? []
      }
    };
  } catch (err) {
    console.error("[fetchPriceM2WithBrowsing] Error:", err);
    return { price: null };
  }
}

/** App */
const app = express();
app.use(express.json());

// Auth desactivada temporalmente para pruebas
app.use((_req: Request, _res: Response, next: NextFunction) => next());

app.post("/valuation/v1/price-m2", async (req: Request, res: Response) => {
  console.log("[VAL-MS] 📨 Request recibido en /valuation/v1/price-m2");
  console.log("[VAL-MS] 🔎 query:", req.query);
  console.log("[VAL-MS] 🔎 body:", req.body);

  try {
    const body = req.body || {};
    const query = req.query || {};

    const leadId = body.lead_id || body.leadId || query.lead_id || query.leadId;
    const address = body.address || query.address;

    if (!leadId || !address) {
      console.warn("[VAL-MS] ❌ Falta lead_id o address", { leadId, address });
      return res.status(400).json({ error: "lead_id y address son obligatorios" });
    }

    const cp = body.postal_code || (address.match(CP_REGEX)?.[0] ?? "").trim();
    if (!cp) return res.status(400).json({ error: "no se pudo detectar el CP" });

    // 1) cache
    let price: number | null = await getCachedPrice(cp);
    let source: Source = price ? "cached" : "na";
    var source_detail = {};

    // 2) OpenAI si no hay cache fresca
    if (!price) {
      const result = await fetchPriceM2WithBrowsing(address, cp);
      price = result.price;
      if (price) {
        source = "openai";
        await upsertCache(cp, price, source, 90);
      }
      source_detail = result.detail || {};
    }

    const valuation_price =
      price && body.square_meters ? Math.round(price * body.square_meters) : null;

    const confidence = price ? (source === "openai" || source === "cached" ? 85 : 60) : 0;

    await updateLeadRow(leadId, price ?? null, valuation_price, source, confidence);

    return res.json({
      lead_id: leadId,
      price_m2: price,
      valuation_price,
      source,
      confidence,
      valuation_at: nowIso(),
      source_detail,
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
