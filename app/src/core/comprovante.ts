import axios from "axios";
import { pool } from "../db";
import type { Usuario } from "./allowlist";
import { config } from "../config";
import { responder } from "./reply";
import { enc } from "../crypto";
import { log } from "../log";

const VISION_MODEL = process.env.GROQ_VISION_MODEL || "meta-llama/llama-4-scout-17b-16e-instruct";

function brl(v: number): string {
  return Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

/**
 * Lê o valor total de um comprovante a partir da imagem (base64).
 * Retorna { valor, descricao } — valor pode ser null se não conseguir ler.
 * LGPD: não extrai dados pessoais, só valor/estabelecimento.
 */
export async function lerComprovante(imageBase64: string, mime = "image/jpeg"): Promise<{ valor: number | null; descricao: string | null }> {
  try {
    const dataUrl = `data:${mime};base64,${imageBase64}`;
    const r = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        model: VISION_MODEL,
        temperature: 0,
        max_tokens: 150,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  "Esta é a foto de um comprovante/recibo/nota. Extraia o VALOR TOTAL pago e um nome curto do estabelecimento (se visível). " +
                  "Responda APENAS em JSON: {\"valor\": number|null, \"descricao\": string|null}. " +
                  "valor é o total em reais (ponto decimal, sem R$). NÃO inclua dados pessoais (CPF, nome de pessoa, cartão).",
              },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
      },
      { headers: { Authorization: `Bearer ${config.GROQ_API_KEY}`, "Content-Type": "application/json" }, timeout: 30000 }
    );
    const raw = r.data?.choices?.[0]?.message?.content ?? "{}";
    const j = JSON.parse(raw);
    const valor = j.valor != null && !isNaN(Number(j.valor)) ? Number(j.valor) : null;
    const descricao = j.descricao ? String(j.descricao).slice(0, 60) : null;
    return { valor, descricao };
  } catch (e) {
    log("warn", "comprovante: visao falhou", { e: String(e) });
    return { valor: null, descricao: null };
  }
}

/**
 * Processa uma IMAGEM recebida como comprovante:
 * lê o valor, guarda como pendente e pergunta a categoria.
 */
export async function processarComprovante(user: Usuario, phone: string, imageBase64: string | undefined, mime?: string): Promise<void> {
  if (!imageBase64) {
    await responder(user, phone, "Recebi a imagem, mas não consegui baixá-la. Pode reenviar? 🙏");
    return;
  }
  const { valor, descricao } = await lerComprovante(imageBase64, mime);

  // guarda pendência (substitui pendência anterior do mesmo user p/ não acumular)
  await pool.query(`DELETE FROM gastos_pendentes WHERE user_id=$1`, [user.id]);
  await pool.query(`INSERT INTO gastos_pendentes (user_id, valor, descricao) VALUES ($1,$2,$3)`, [user.id, valor, descricao]);

  const ondeTxt = descricao ? ` em *${descricao}*` : "";
  if (valor != null) {
    await responder(user, phone, `📷 Comprovante recebido: *${brl(valor)}*${ondeTxt}.\nEm qual *categoria* eu lanço esse gasto? (ex: mercado, transporte, contas...)`);
  } else {
    await responder(user, phone, `📷 Comprovante recebido${ondeTxt}, mas não consegui ler o valor. Me diz o *valor* e a *categoria* (ex: "50 mercado").`);
  }
}

/**
 * Se houver um gasto pendente, interpreta a próxima mensagem como categoria
 * (e opcionalmente valor, caso não tenha sido lido). Registra o lançamento.
 * Retorna true se consumiu a mensagem.
 */
export async function tentarCompletarComprovante(user: Usuario, phone: string, texto: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT id, valor, descricao FROM gastos_pendentes WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1`,
    [user.id]
  );
  const pend = rows[0];
  if (!pend) return false;

  const t = texto.trim();
  // cancelar
  if (/^(cancela|cancelar|deixa|esquece|não|nao)$/i.test(t)) {
    await pool.query(`DELETE FROM gastos_pendentes WHERE id=$1`, [pend.id]);
    await responder(user, phone, "Ok, descartei esse comprovante 👍");
    return true;
  }

  // tenta achar um valor no texto (caso a foto não tenha valor)
  let valor: number | null = pend.valor != null ? Number(pend.valor) : null;
  if (valor == null) {
    const m = t.replace(/r\$\s*/i, "").match(/(\d+[.,]?\d*)/);
    if (m) valor = Number(m[1].replace(".", "").replace(",", "."));
  }
  // categoria = texto sem o valor
  let categoria = t.replace(/r\$\s*/i, "").replace(/\b\d+[.,]?\d*\b/, "").trim();
  if (!categoria) categoria = pend.descricao || "outros";

  if (valor == null || valor <= 0) {
    await responder(user, phone, "Não peguei o valor. Me manda assim: *50 mercado* 🙂");
    return true;
  }

  await pool.query(
    `INSERT INTO lancamentos (user_id, tipo, valor, categoria, descricao) VALUES ($1,'saida',$2,$3,$4)`,
    [user.id, valor, categoria.slice(0, 40), enc(pend.descricao || null)]
  );
  await pool.query(`DELETE FROM gastos_pendentes WHERE id=$1`, [pend.id]);
  await responder(user, phone, `💸 Lançado: *${brl(valor)}* em *${categoria}*. ✅`);
  log("info", "comprovante registrado", { phone, valor, categoria });
  return true;
}
