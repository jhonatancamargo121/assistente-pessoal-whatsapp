import { pool } from "../db";
import type { Usuario } from "./allowlist";
import type { IntentResult } from "../ai/intent";
import { handle, type HandlerResult } from "./handlers";

/**
 * Camada de confirmação: ações CRÍTICAS (finanças, leads) só são executadas
 * depois que o usuário confirma com "sim". Evita salvar dado errado por alucinação.
 */

// Aceita confirmação/negação mesmo com texto extra ("sim, às 15h", "pode lançar", "não, deixa").
//  após o token evita falso positivo (ex: "simples", "nada a ver" não disparam indevidamente).
const AFIRMA = /^\s*(sim|claro|isso(?: mesmo)?|confirmo|confirmar|confirma|pode(?: ser)?|ok|okay|certo|exato|positivo|aham|uhum|manda|vai|bora|👍|👌)/i;
const AFIRMA_CURTA = /^\s*s\s*[.!]?\s*$/i; // "s" sozinho
const NEGA = /^\s*(n[ãa]o|cancela(?:r)?|errado|negativo|deixa|esquece|esque[çc]a)/i;
const NEGA_CURTA = /^\s*n\s*[.!]?\s*$/i; // "n" sozinho

/** Intenções que exigem confirmação antes de salvar (dado crítico).
 *  Obs: criar_lead saiu daqui — agora é tratado pelo wizard (CRM) ou
 *  responde "CRM não ativado" direto (sem CRM). Evita confirm + negação. */
export function precisaConfirmar(intent: IntentResult): boolean {
  return (
    intent.intent === "registrar_gasto" ||
    intent.intent === "registrar_entrada"
  );
}

function brl(v: unknown): string {
  return Number(v).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function resumo(intent: IntentResult): string {
  switch (intent.intent) {
    case "registrar_gasto":
      return `💸 Registrar *gasto* de ${brl(intent.valor)}${intent.categoria ? ` em *${intent.categoria}*` : ""}`;
    case "registrar_entrada":
      return `💰 Registrar *entrada* de ${brl(intent.valor)}${intent.categoria ? ` em *${intent.categoria}*` : ""}`;
    case "criar_lead":
      return `🏢 Cadastrar lead *${intent.lead_nome || "?"}* (${intent.lead_telefone || "?"})${intent.lead_interesse ? ` — ${intent.lead_interesse}` : ""}`;
    default:
      return "esta ação";
  }
}

/** Guarda a ação proposta e devolve a pergunta de confirmação. */
export async function prepararConfirmacao(user: Usuario, intent: IntentResult): Promise<string> {
  await pool.query(`UPDATE usuarios SET pending_acao=$1 WHERE id=$2`, [JSON.stringify(intent), user.id]);
  return `${resumo(intent)}.\n\nConfirma? Responda *sim* ou *não*.`;
}

/**
 * Se há ação pendente e a mensagem é sim/não, resolve.
 * - sim  → executa a ação (via handle) e limpa
 * - não  → cancela e limpa
 * - outra → descarta a pendência e segue o fluxo normal (tratou=false)
 */
export async function checarPendente(user: Usuario, texto: string): Promise<{ tratou: boolean; result?: HandlerResult }> {
  const { rows } = await pool.query(`SELECT pending_acao FROM usuarios WHERE id=$1`, [user.id]);
  const pend = rows[0]?.pending_acao as IntentResult | null;
  if (!pend) return { tratou: false };

  if (AFIRMA.test(texto) || AFIRMA_CURTA.test(texto)) {
    await pool.query(`UPDATE usuarios SET pending_acao=NULL WHERE id=$1`, [user.id]);
    const result = await handle(pend, user, ""); // executa de verdade agora
    return { tratou: true, result };
  }
  if (NEGA.test(texto) || NEGA_CURTA.test(texto)) {
    await pool.query(`UPDATE usuarios SET pending_acao=NULL WHERE id=$1`, [user.id]);
    return { tratou: true, result: { reply: "Ok, cancelei 👍 É só me dizer de novo quando quiser.", provider: "template" } };
  }
  // Não respondeu sim/não → descarta a pendência e processa a nova mensagem normalmente.
  await pool.query(`UPDATE usuarios SET pending_acao=NULL WHERE id=$1`, [user.id]);
  return { tratou: false };
}
