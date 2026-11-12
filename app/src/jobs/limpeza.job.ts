import { pool } from "../db";
import { log } from "../log";

/**
 * Retenção de dados (LGPD + performance): apaga registros com mais de 90 dias
 * das tabelas que só crescem (histórico de mensagens e tentativas de uso indevido).
 * Roda na subida e depois 1x por dia.
 */
const RETENCAO_DIAS = Number(process.env.RETENCAO_DIAS || 90);
let timer: NodeJS.Timeout | null = null;

async function limpar(): Promise<void> {
  try {
    const m = await pool.query(`DELETE FROM mensagens WHERE created_at < now() - ($1 || ' days')::interval`, [RETENCAO_DIAS]);
    let t = 0;
    try {
      const r = await pool.query(`DELETE FROM tentativas_indevidas WHERE created_at < now() - ($1 || ' days')::interval`, [RETENCAO_DIAS]);
      t = r.rowCount || 0;
    } catch { /* tabela pode não ter created_at — não bloqueia */ }
    if ((m.rowCount || 0) + t > 0) {
      log("info", "limpeza: registros antigos removidos", { mensagens: m.rowCount, tentativas: t, retencao_dias: RETENCAO_DIAS });
    }
  } catch (e) {
    log("warn", "limpeza falhou", { e: String(e) });
  }
}

export function startLimpezaJob(): void {
  limpar();
  timer = setInterval(limpar, 24 * 60 * 60 * 1000);
  log("info", "job de limpeza iniciado", { retencao_dias: RETENCAO_DIAS });
}

export function stopLimpezaJob(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
