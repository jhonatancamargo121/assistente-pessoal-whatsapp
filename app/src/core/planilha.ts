import * as XLSX from "xlsx";
import { pool } from "../db";
import type { Usuario } from "./allowlist";
import { responder } from "./reply";
import { log } from "../log";

function brl(v: number | null): string {
  if (v == null) return "—";
  return Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

interface CatLida { nome: string; meta: number | null; }

/**
 * Lê uma planilha (.xlsx/.csv em base64) e extrai categorias + metas.
 * Heurística: procura colunas tipo "categoria" e "meta/orçamento/valor/limite".
 * Se não houver cabeçalho claro, usa a 1ª coluna como categoria e a 2ª (numérica) como meta.
 */
export function lerPlanilha(base64: string): CatLida[] {
  const buf = Buffer.from(base64, "base64");
  const wb = XLSX.read(buf, { type: "buffer" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  if (!ws) return [];
  const linhas: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false });
  if (!linhas.length) return [];

  // tenta achar índices de coluna pelo cabeçalho
  const head = (linhas[0] || []).map((c) => String(c ?? "").toLowerCase().trim());
  let idxCat = head.findIndex((h) => /categoria|descri|item|nome|conta/.test(h));
  let idxMeta = head.findIndex((h) => /meta|or[çc]amento|limite|planejado|valor|previsto/.test(h));
  let inicio = 1;
  if (idxCat === -1) { idxCat = 0; idxMeta = idxMeta === -1 ? 1 : idxMeta; inicio = 0; } // sem cabeçalho

  const out: CatLida[] = [];
  const vistos = new Set<string>();
  for (let i = inicio; i < linhas.length && out.length < 60; i++) {
    const row = linhas[i] || [];
    const nome = String(row[idxCat] ?? "").trim();
    if (!nome || nome.length > 40) continue;
    if (/^(categoria|total|soma|saldo)$/i.test(nome)) continue; // ignora cabeçalho/totais
    const key = nome.toLowerCase();
    if (vistos.has(key)) continue;
    vistos.add(key);
    let meta: number | null = null;
    if (idxMeta >= 0 && row[idxMeta] != null && row[idxMeta] !== "") {
      const n = Number(String(row[idxMeta]).replace(/[^\d,.-]/g, "").replace(/\.(?=\d{3})/g, "").replace(",", "."));
      if (!isNaN(n) && n > 0) meta = n;
    }
    out.push({ nome, meta });
  }
  return out;
}

/**
 * Processa o DOCUMENTO recebido como planilha modelo:
 * lê categorias/metas, mostra resumo e guarda pendente p/ confirmação.
 */
export async function processarPlanilha(user: Usuario, phone: string, base64: string | undefined, fileName?: string): Promise<void> {
  if (!base64) {
    await responder(user, phone, "Recebi o arquivo, mas não consegui baixá-lo. Pode reenviar a planilha? 🙏");
    return;
  }
  if (fileName && !/\.(xlsx|xls|csv)$/i.test(fileName)) {
    await responder(user, phone, "Esse arquivo não parece uma planilha. Me envia um Excel (.xlsx) ou CSV com suas categorias 🙂");
    return;
  }
  let cats: CatLida[];
  try {
    cats = lerPlanilha(base64);
  } catch (e) {
    log("warn", "planilha: leitura falhou", { e: String(e) });
    await responder(user, phone, "Não consegui ler essa planilha. Confere se é um Excel/CSV com uma coluna de categorias 🙏");
    return;
  }
  if (!cats.length) {
    await responder(user, phone, "Não encontrei categorias na planilha. Deixe uma coluna *Categoria* (e, se quiser, *Meta*) e reenvie 🙂");
    return;
  }

  await pool.query(
    `INSERT INTO import_planilha_pendente (user_id, dados) VALUES ($1,$2)
     ON CONFLICT (user_id) DO UPDATE SET dados=EXCLUDED.dados, created_at=now()`,
    [user.id, JSON.stringify(cats)]
  );

  const comMeta = cats.filter((c) => c.meta != null);
  const linhas = cats.slice(0, 20).map((c) => `• ${c.nome}${c.meta != null ? ` — meta ${brl(c.meta)}` : ""}`);
  const resumo =
    `📊 Li sua planilha e encontrei *${cats.length} categorias*` +
    (comMeta.length ? ` (${comMeta.length} com meta)` : "") + `:\n\n` +
    linhas.join("\n") + (cats.length > 20 ? `\n…e mais ${cats.length - 20}.` : "") +
    `\n\nQuer que eu configure seu controle financeiro com essas categorias? Responda *sim* para confirmar ou *não* para cancelar.`;
  await responder(user, phone, resumo);
  log("info", "planilha lida (pendente)", { phone, categorias: cats.length });
}

/**
 * Se houver import pendente, interpreta a resposta (sim/não) e aplica.
 * Retorna true se consumiu a mensagem.
 */
export async function tentarConfirmarPlanilha(user: Usuario, phone: string, texto: string): Promise<boolean> {
  const { rows } = await pool.query(`SELECT dados FROM import_planilha_pendente WHERE user_id=$1`, [user.id]);
  if (!rows[0]) return false;

  const t = texto.trim().toLowerCase();
  const sim = /^(sim|s|confirmar|confirmo|pode|ok|isso|aplicar|configura)/i.test(t);
  const nao = /^(n[ãa]o|nao|cancela|cancelar|deixa|esquece)/i.test(t);
  if (!sim && !nao) {
    await responder(user, phone, "Só pra confirmar: aplico as categorias da planilha? Responda *sim* ou *não* 🙂");
    return true;
  }
  if (nao) {
    await pool.query(`DELETE FROM import_planilha_pendente WHERE user_id=$1`, [user.id]);
    await responder(user, phone, "Tudo bem, não alterei seu controle 👍");
    return true;
  }

  // aplica
  const cats: CatLida[] = rows[0].dados;
  let n = 0;
  for (const c of cats) {
    await pool.query(
      `INSERT INTO categorias_usuario (user_id, nome, meta_valor) VALUES ($1,$2,$3)
       ON CONFLICT (user_id, nome) DO UPDATE SET meta_valor=EXCLUDED.meta_valor`,
      [user.id, c.nome.slice(0, 40), c.meta]
    );
    n++;
  }
  await pool.query(`DELETE FROM import_planilha_pendente WHERE user_id=$1`, [user.id]);
  await responder(user, phone, `✅ Pronto! Configurei seu controle com *${n} categorias*. Agora é só ir lançando seus gastos que eu organizo por elas 🙂`);
  log("info", "planilha aplicada", { phone, categorias: n });
  return true;
}
