import { pool } from "../db";
import { dec } from "../crypto";
import type { ChatMsg } from "../ai/groq";

/**
 * Memória de conversa POR USUÁRIO.
 * Lê as últimas mensagens já gravadas (tabela mensagens) e devolve no formato
 * de chat (user/assistant) em ordem cronológica, pronto pra alimentar a IA.
 *
 * IMPORTANTE: só considera mensagens RECENTES (janela de sessão). Mensagens de
 * horas/dias atrás NÃO entram como contexto — isso evita o bot "se perder" e
 * responder com assunto velho (vazamento de contexto antigo).
 */

const JANELA_HORAS = 6; // só mensagens das últimas 6h contam como contexto

const MEDIA_PLACEHOLDER: Record<string, string> = {
  image: "[enviei uma imagem/comprovante]",
  document: "[enviei um documento]",
  audio: "[enviei um áudio]",
};

function limpar(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, 500);
}

/**
 * Histórico recente do usuário como turnos de chat (mais antigo → mais novo).
 * @param limit nº de mensagens (in+out) a recuperar. Default 10.
 */
export async function getHistorico(userId: string, limit = 10): Promise<ChatMsg[]> {
  try {
    const { rows } = await pool.query(
      `SELECT direcao, tipo, conteudo, created_at FROM mensagens
        WHERE user_id = $1
          AND direcao IN ('in','out')
          AND created_at > now() - ($3 || ' hours')::interval
        ORDER BY created_at DESC
        LIMIT $2`,
      [userId, Math.max(1, Math.min(30, limit)), String(JANELA_HORAS)]
    );
    const out: ChatMsg[] = [];
    // rows vem do mais novo p/ o mais antigo → percorre invertido p/ cronológico
    for (let i = rows.length - 1; i >= 0; i--) {
      const r: any = rows[i];
      let txt = dec(r.conteudo) || "";
      if (!txt || !txt.trim()) {
        txt = MEDIA_PLACEHOLDER[r.tipo] || "";
      }
      txt = limpar(txt);
      if (!txt) continue;
      out.push({ role: r.direcao === "in" ? "user" : "assistant", content: txt });
    }
    return out;
  } catch {
    return [];
  }
}
