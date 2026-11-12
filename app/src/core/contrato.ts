import axios from "axios";
import { promises as fs } from "fs";
import path from "path";
import { config } from "../config";
import { log } from "../log";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

/**
 * Geração automática de CONTRATO DE INTERMEDIAÇÃO.
 * - Visão (Groq) extrai dados do RG/CNH e do comprovante de endereço.
 * - Cada corretor tem um TEMPLATE (PDF) + mapa de campos (coordenadas).
 * - preencherContrato() sobrepõe os valores no PDF e devolve base64 p/ enviar no WhatsApp.
 * LGPD: a foto não é persistida; só os campos necessários ao contrato.
 */
const VISION_MODEL = process.env.GROQ_VISION_MODEL || "meta-llama/llama-4-scout-17b-16e-instruct";

async function visaoJson(imageBase64: string, mime: string, prompt: string, maxTokens = 500): Promise<any> {
  const dataUrl = `data:${mime};base64,${imageBase64}`;
  const r = await axios.post(
    "https://api.groq.com/openai/v1/chat/completions",
    {
      model: VISION_MODEL,
      temperature: 0,
      max_tokens: maxTokens,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: dataUrl } }] }],
    },
    { headers: { Authorization: `Bearer ${config.GROQ_API_KEY}`, "Content-Type": "application/json" }, timeout: 45000 }
  );
  const raw = r.data?.choices?.[0]?.message?.content ?? "{}";
  return JSON.parse(raw);
}

export interface DadosCliente {
  nome?: string | null; cpf?: string | null; rg?: string | null; orgao?: string | null;
  nascimento?: string | null; mae?: string | null; pai?: string | null;
  estado_civil?: string | null; naturalidade?: string | null;
  endereco?: string | null; cidade_uf?: string | null; cep?: string | null;
  email?: string | null; profissao?: string | null; telefone?: string | null;
  quadra?: string | null; lote?: string | null; area?: string | null; rua?: string | null;
  valor?: string | null;
  // 2º contratante (cônjuge)
  conj_nome?: string | null; conj_cpf?: string | null; conj_rg?: string | null;
  conj_orgao?: string | null; conj_estado_civil?: string | null;
  // pagamento da intermediação
  pagamento?: string | null; // "avista" | "parcelado"
  parcelas?: Array<{ valor: string; venc: string }> | null;          // do TOTAL (3,3%) — recibo
  parcelas_corretor?: Array<{ valor: string; venc: string }> | null; // da parte do corretor (3,0%)
  valor_corretor?: string | null; // 3,0% (imobiliária/corretor)
  valor_gerente?: string | null;  // 0,3% (gerente de vendas)
}

/** OCR de documento de identidade (RG/CIN/CNH). */
export async function extrairDocumento(imageBase64: string, mime = "image/jpeg"): Promise<Partial<DadosCliente>> {
  try {
    return await visaoJson(
      imageBase64, mime,
      "Esta é a foto de um documento de identidade brasileiro (RG/CIN/CNH). Extraia os dados em JSON: " +
        '{"nome":string|null,"cpf":string|null,"rg":string|null,"orgao":string|null,"nascimento":"DD/MM/AAAA"|null,"mae":string|null,"pai":string|null,"estado_civil":string|null,"naturalidade":string|null}. ' +
        "cpf e rg com a pontuação do documento. estado_civil só se aparecer (SOLTEIRO/CASADO/DIVORCIADO/etc). Campo ausente = null. NUNCA invente."
    );
  } catch (e) { log("warn", "contrato: extrairDocumento falhou", { e: String(e) }); return {}; }
}

/** OCR de comprovante de endereço (conta de luz/água/etc). */
export async function extrairEndereco(imageBase64: string, mime = "image/jpeg"): Promise<Partial<DadosCliente>> {
  try {
    return await visaoJson(
      imageBase64, mime,
      "Esta é a foto de um comprovante de endereço (conta de luz/água/telefone). Extraia o endereço do titular em JSON: " +
        '{"endereco":string|null,"cidade_uf":"Cidade - UF"|null,"cep":string|null}. ' +
        "endereco = rua, número, complemento e bairro resumidos em uma linha. Campo ausente = null. NUNCA invente."
    );
  } catch (e) { log("warn", "contrato: extrairEndereco falhou", { e: String(e) }); return {}; }
}

// ───────── Registro de TEMPLATES por corretor (chave = email do CRM) ─────────
type Campo = { page: number; x: number; yTop: number; size?: number; val: (d: DadosCliente) => string | null | undefined };
export interface Template { file: string; label: string; campos: Campo[] }

const TEMPLATES: Record<string, Template> = {
  default: {
    file: "walquiria.pdf",
    label: "Atitude Negócios — Walquiria",
    campos: [
      // PÁGINA 1 (idx 0) — RECIBO (comprador)
      { page: 0, x: 170, yTop: 157, size: 8, val: (d) => d.nome },
      { page: 0, x: 82, yTop: 184, size: 8, val: (d) => d.cpf },
      { page: 0, x: 290, yTop: 184, size: 7, val: (d) => d.rg },
      { page: 0, x: 474, yTop: 184, size: 7, val: (d) => d.orgao },
      { page: 0, x: 86, yTop: 202, size: 6.5, val: (d) => d.endereco },
      { page: 0, x: 404, yTop: 202, size: 8, val: (d) => d.telefone },
      { page: 0, x: 76, yTop: 219, size: 7.5, val: (d) => d.cidade_uf },
      { page: 0, x: 463, yTop: 219, size: 8, val: (d) => d.cep },
      { page: 0, x: 60, yTop: 276, size: 9, val: (d) => d.quadra },
      { page: 0, x: 150, yTop: 276, size: 9, val: (d) => d.lote },
      // PÁGINA 2 (idx 1) — 1ª Contratante (cliente)
      { page: 1, x: 270, yTop: 468, size: 9, val: (d) => d.nome },
      { page: 1, x: 66, yTop: 494, size: 8, val: (d) => d.cpf },
      { page: 1, x: 255, yTop: 494, size: 7, val: (d) => (d.rg ? `${d.rg}${d.orgao ? "  " + d.orgao : ""}` : null) },
      { page: 1, x: 476, yTop: 494, size: 8, val: (d) => d.estado_civil },
      { page: 1, x: 92, yTop: 526, size: 7, val: (d) => d.endereco },
      { page: 1, x: 462, yTop: 526, size: 8, val: (d) => d.cidade_uf },
      { page: 1, x: 77, yTop: 552, size: 8, val: (d) => d.email },
      { page: 1, x: 436, yTop: 552, size: 8, val: (d) => d.cep },
      { page: 1, x: 91, yTop: 577, size: 8, val: (d) => d.profissao },
      { page: 1, x: 263, yTop: 577, size: 8, val: (d) => d.telefone },
      // PÁGINA 2 (idx 1) — 2ª Contratante (cônjuge)
      { page: 1, x: 300, yTop: 611, size: 9, val: (d) => d.conj_nome },
      { page: 1, x: 66, yTop: 636, size: 8, val: (d) => d.conj_cpf },
      { page: 1, x: 255, yTop: 636, size: 7, val: (d) => (d.conj_rg ? `${d.conj_rg}${d.conj_orgao ? "  " + d.conj_orgao : ""}` : null) },
      { page: 1, x: 476, yTop: 636, size: 8, val: (d) => d.conj_estado_civil },
      // PÁGINA 3 (idx 2) — Imóvel + valor
      { page: 2, x: 85, yTop: 188, size: 9, val: (d) => d.quadra },
      { page: 2, x: 254, yTop: 188, size: 9, val: (d) => d.lote },
      { page: 2, x: 305, yTop: 221, size: 8, val: (d) => d.rua },
      { page: 2, x: 320, yTop: 303, size: 9, val: (d) => d.valor },
      // PÁGINA 3 — quebra da comissão (3,0% corretor + 0,3% gerente)
      { page: 2, x: 230, yTop: 354, size: 8, val: (d) => d.valor_corretor },
      { page: 2, x: 230, yTop: 625, size: 8, val: (d) => d.valor_gerente },
      { page: 2, x: 230, yTop: 716, size: 8, val: (d) => d.valor_gerente }, // gerente à vista
      // PÁGINA 3 — pagamento corretor (à vista usa a linha "À VISTA"; parcelas 1-3 = parte do corretor)
      { page: 2, x: 205, yTop: 455, size: 8, val: (d) => (d.pagamento === "avista" ? d.valor_corretor || d.valor : null) },
      { page: 2, x: 200, yTop: 538, size: 8, val: (d) => d.parcelas_corretor?.[0]?.valor },
      { page: 2, x: 320, yTop: 538, size: 8, val: (d) => d.parcelas_corretor?.[0]?.venc },
      { page: 2, x: 200, yTop: 565, size: 8, val: (d) => d.parcelas_corretor?.[1]?.valor },
      { page: 2, x: 320, yTop: 565, size: 8, val: (d) => d.parcelas_corretor?.[1]?.venc },
      { page: 2, x: 200, yTop: 593, size: 8, val: (d) => d.parcelas_corretor?.[2]?.valor },
      { page: 2, x: 320, yTop: 593, size: 8, val: (d) => d.parcelas_corretor?.[2]?.venc },
      // PÁGINA 1 (recibo) — parcelas
      { page: 0, x: 535, yTop: 350, size: 8, val: (d) => (d.parcelas?.length ? String(d.parcelas.length) : null) },
      { page: 0, x: 110, yTop: 364, size: 8, val: (d) => d.parcelas?.[0]?.valor },
      { page: 0, x: 420, yTop: 364, size: 8, val: (d) => d.parcelas?.[0]?.venc },
      { page: 0, x: 110, yTop: 378, size: 8, val: (d) => d.parcelas?.[1]?.valor },
      { page: 0, x: 420, yTop: 378, size: 8, val: (d) => d.parcelas?.[1]?.venc },
      { page: 0, x: 110, yTop: 393, size: 8, val: (d) => d.parcelas?.[2]?.valor },
      { page: 0, x: 420, yTop: 393, size: 8, val: (d) => d.parcelas?.[2]?.venc },
      // PÁGINA 5 (idx 4) — Declaração de Estado Civil (só faz sentido p/ solteiro)
      { page: 4, x: 112, yTop: 263, size: 9, val: (d) => (/solteir/i.test(d.estado_civil || "") ? d.nome : null) },
      { page: 4, x: 170, yTop: 284, size: 9, val: (d) => (/solteir/i.test(d.estado_civil || "") ? d.nascimento : null) },
      { page: 4, x: 292, yTop: 284, size: 8, val: (d) => (/solteir/i.test(d.estado_civil || "") ? d.mae : null) },
      { page: 4, x: 95, yTop: 305, size: 8, val: (d) => (/solteir/i.test(d.estado_civil || "") ? d.pai : null) },
      { page: 4, x: 485, yTop: 305, size: 7, val: (d) => (/solteir/i.test(d.estado_civil || "") ? d.rg : null) },
      { page: 4, x: 295, yTop: 327, size: 8, val: (d) => (/solteir/i.test(d.estado_civil || "") ? d.cpf : null) },
      // PÁGINA 6 (idx 5) — Declaração de Residência
      { page: 5, x: 100, yTop: 129, size: 9, val: (d) => d.nome },
      { page: 5, x: 152, yTop: 164, size: 8, val: (d) => d.rg },
      { page: 5, x: 132, yTop: 183, size: 8, val: (d) => d.cpf },
      { page: 5, x: 374, yTop: 183, size: 8, val: (d) => d.estado_civil },
      { page: 5, x: 85, yTop: 219, size: 8, val: (d) => d.profissao },
      { page: 5, x: 318, yTop: 219, size: 7.5, val: (d) => d.naturalidade },
      { page: 5, x: 130, yTop: 300, size: 7.5, val: (d) => d.endereco },
      { page: 5, x: 125, yTop: 353, size: 8, val: (d) => d.cidade_uf },
      { page: 5, x: 460, yTop: 353, size: 8, val: (d) => d.cep },
      { page: 5, x: 138, yTop: 379, size: 8, val: (d) => d.telefone },
      { page: 5, x: 122, yTop: 406, size: 8, val: (d) => d.email },
      { page: 5, x: 200, yTop: 686, size: 9, val: (d) => d.nome },
    ],
  },
};

export function templateDoCorretor(email?: string | null): Template {
  return TEMPLATES[String(email || "").toLowerCase()] || TEMPLATES.default;
}

const TEMPLATES_DIR = process.env.TEMPLATES_DIR || path.join(process.cwd(), "templates");

// remove caracteres fora do Latin-1 (pdf-lib/Helvetica não suporta)
function safe(s: string): string {
  return String(s).replace(/[^\x09\x0A\x0D\x20-\xFF]/g, "");
}

export async function preencherContrato(tpl: Template, d: DadosCliente, bytesOverride?: Buffer): Promise<{ base64: string; filename: string }> {
  // bytesOverride = modelo PRÓPRIO do corretor (subido no CRM); senão usa o padrão empacotado.
  const bytes = bytesOverride ?? (await fs.readFile(path.join(TEMPLATES_DIR, tpl.file)));
  const pdf = await PDFDocument.load(bytes);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const pages = pdf.getPages();
  const BLUE = rgb(0.06, 0.12, 0.55);
  for (const c of tpl.campos) {
    const v = c.val(d);
    if (v == null || String(v).trim() === "") continue;
    const pg = pages[c.page];
    if (!pg) continue;
    const size = c.size || 8;
    pg.drawText(safe(String(v)), { x: c.x, y: pg.getHeight() - c.yTop - size, size, font, color: BLUE });
  }
  const out = await pdf.save();
  const nome = (d.nome || "cliente").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 30);
  return { base64: Buffer.from(out).toString("base64"), filename: `contrato_${nome || "cliente"}.pdf` };
}
