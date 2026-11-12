import { spawn } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import mammoth from "mammoth";
import { pool } from "../db";
import type { Usuario } from "./allowlist";
import { responder } from "./reply";
import { deepseekChat } from "../ai/deepseek";
import { lerComprovante } from "./comprovante";
import { log } from "../log";

function brl(v: number): string {
  return Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function ext(fileName?: string): string {
  return (fileName || "").toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || "";
}

/** Extrai texto de PDF via pdftotext (poppler). */
function pdfParaTexto(buf: Buffer): Promise<string> {
  return new Promise((resolve) => {
    const p = spawn("pdftotext", ["-layout", "-", "-"], { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    p.stdout.on("data", (d) => out.push(d));
    p.on("error", () => resolve(""));
    p.on("close", () => resolve(Buffer.concat(out).toString("utf8")));
    p.stdin.write(buf);
    p.stdin.end();
  });
}

/** Converte as primeiras páginas de um PDF em PNG base64 (via pdftoppm/poppler). */
async function pdfParaImagens(buf: Buffer, maxPaginas = 2): Promise<string[]> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pdfimg-"));
  const pdfPath = path.join(dir, "in.pdf");
  try {
    await fs.writeFile(pdfPath, buf);
    await new Promise<void>((resolve) => {
      const pp = spawn(
        "pdftoppm",
        ["-png", "-r", "150", "-f", "1", "-l", String(maxPaginas), pdfPath, path.join(dir, "pg")],
        { stdio: "ignore" }
      );
      pp.on("error", () => resolve());
      pp.on("close", () => resolve());
    });
    const arquivos = (await fs.readdir(dir)).filter((f) => f.endsWith(".png")).sort();
    const out: string[] = [];
    for (const f of arquivos.slice(0, maxPaginas)) {
      const b = await fs.readFile(path.join(dir, f));
      out.push(b.toString("base64"));
    }
    return out;
  } catch (err) {
    log("warn", "documento: pdf->imagem falhou", { e: String(err) });
    return [];
  } finally {
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Extrai o texto de um documento (pdf/docx/txt) a partir do base64. */
export async function extrairTexto(base64: string, fileName?: string): Promise<string> {
  const buf = Buffer.from(base64, "base64");
  const e = ext(fileName);
  try {
    if (e === "pdf") return (await pdfParaTexto(buf)).trim();
    if (e === "docx") return (await mammoth.extractRawText({ buffer: buf })).value.trim();
    if (e === "txt" || e === "csv") return buf.toString("utf8").trim();
    // fallback: tenta como texto puro
    return buf.toString("utf8").replace(/[^\x09\x0A\x0D\x20-\x7E -ɏ]/g, "").trim();
  } catch (err) {
    log("warn", "documento: extrair texto falhou", { e: String(err) });
    return "";
  }
}

/** Procura um valor monetário "total" no texto de um comprovante/conta. */
function acharValor(texto: string): number | null {
  // remove ruídos que enganam o parser: CPF, CNPJ, datas
  const limpo = texto
    .replace(/\d{3}\.\d{3}\.\d{3}-?\d{2}/g, " ")          // CPF
    .replace(/\d{2}\.\d{3}\.\d{3}\/\d{4}-?\d{2}/g, " ")   // CNPJ
    .replace(/\d{2}\/\d{2}\/\d{2,4}/g, " ");             // datas
  const t = limpo.toLowerCase();
  const linhas = t.split(/\n/);
  // 1) linhas com rótulo forte de total
  const fortes = linhas.filter((l) =>
    /(valor\s*total|total\s*a?\s*pagar|valor\s*a\s*pagar|total\s*geral|total\s*do\s*documento|\btotal\b)/.test(l)
  );
  // 2) linhas com rótulo fraco
  const fracas = linhas.filter((l) => /(valor|vlr|importe|montante)/.test(l));
  const pick = (str: string): number[] =>
    [...str.matchAll(/r?\$?\s*(\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2})/g)]
      .map((m) => Number(m[1].replace(/\./g, "").replace(",", ".")))
      .filter((n) => !isNaN(n) && n > 0 && n < 10_000_000);
  // prioridade: rótulo forte > rótulo fraco > documento inteiro
  for (const grupo of [fortes, fracas]) {
    if (grupo.length) {
      const nums = pick(grupo.join(" "));
      if (nums.length) return Math.max(...nums); // dentro das linhas rotuladas, o maior é o total
    }
  }
  const todos = pick(t);
  return todos.length ? Math.max(...todos) : null;
}

/**
 * Processa um DOCUMENTO (pdf/docx/txt):
 * - PDF sem texto (escaneado) → OCR por visão (pdftoppm + modelo de visão).
 * - Se parecer comprovante/conta (tem valor) → registra gasto pendente e pergunta categoria.
 * - Senão → resume o conteúdo.
 */
export async function processarDocumento(user: Usuario, phone: string, base64: string | undefined, fileName?: string): Promise<void> {
  if (!base64) {
    await responder(user, phone, "Recebi o arquivo, mas não consegui baixá-lo. Pode reenviar? 🙏");
    return;
  }
  let texto = await extrairTexto(base64, fileName);

  // 🔁 PDF sem camada de texto (escaneado/imagem) → OCR por visão.
  if (ext(fileName) === "pdf" && (!texto || texto.replace(/\s/g, "").length < 20)) {
    log("info", "documento: pdf sem texto, tentando OCR por visão", { phone });
    const imagens = await pdfParaImagens(Buffer.from(base64, "base64"), 2);
    for (const imgB64 of imagens) {
      const r = await lerComprovante(imgB64, "image/png");
      if (r.valor != null) {
        const desc = r.descricao || (fileName || "documento").replace(/\.[a-z0-9]+$/i, "").slice(0, 40);
        await pool.query(`DELETE FROM gastos_pendentes WHERE user_id=$1`, [user.id]);
        await pool.query(`INSERT INTO gastos_pendentes (user_id, valor, descricao) VALUES ($1,$2,$3)`, [user.id, r.valor, desc]);
        await responder(
          user,
          phone,
          `📄 Comprovante (PDF) lido: *${brl(r.valor)}*${r.descricao ? ` em *${r.descricao}*` : ""}.\nEm qual *categoria* eu lanço esse gasto? (ex: mercado, contas, transporte...)`
        );
        log("info", "documento: comprovante via OCR", { phone, valor: r.valor });
        return;
      }
    }
    if (!texto || texto.replace(/\s/g, "").length < 20) {
      await responder(user, phone, 'Recebi o PDF mas não consegui ler o valor 🙏 Me manda o *valor* e a *categoria* (ex: "50 mercado") ou envie como *foto*.');
      return;
    }
  }

  if (!texto || texto.length < 5) {
    await responder(user, phone, "Não consegui ler esse documento 🙏 Se for um comprovante, tenta mandar como *foto*.");
    return;
  }

  // É comprovante/conta? (tem palavras-chave financeiras + valor)
  const pareceConta = /(total|valor|pagar|boleto|fatura|nota fiscal|recibo|vencimento|cupom)/i.test(texto);
  const valor = pareceConta ? acharValor(texto) : null;

  if (valor != null) {
    // mesmo fluxo do comprovante por foto: guarda pendente e pergunta categoria
    const desc = (fileName || "documento").replace(/\.[a-z0-9]+$/i, "").slice(0, 40);
    await pool.query(`DELETE FROM gastos_pendentes WHERE user_id=$1`, [user.id]);
    await pool.query(`INSERT INTO gastos_pendentes (user_id, valor, descricao) VALUES ($1,$2,$3)`, [user.id, valor, desc]);
    await responder(user, phone, `📄 Documento recebido: *${brl(valor)}* (${desc}).\nEm qual *categoria* eu lanço esse gasto? (ex: contas, mercado...)`);
    log("info", "documento: comprovante", { phone, valor });
    return;
  }

  // Senão → resume
  try {
    const resumo = await deepseekChat([
      { role: "system", content: "Você resume documentos em PT-BR de forma curta e clara (estilo WhatsApp). Destaque os pontos principais, datas e valores se houver. Máximo 6 linhas." },
      { role: "user", content: `Resuma este documento:\n\n${texto.slice(0, 6000)}` },
    ], { temperature: 0.3 });
    await responder(user, phone, `📄 *Resumo do documento:*\n\n${resumo || "(não consegui resumir)"}`);
    log("info", "documento: resumido", { phone, chars: texto.length });
  } catch (e) {
    await responder(user, phone, "Recebi o documento, mas tive um problema pra resumir agora. Tenta de novo? 🙏");
    log("warn", "documento: resumo falhou", { e: String(e) });
  }
}
