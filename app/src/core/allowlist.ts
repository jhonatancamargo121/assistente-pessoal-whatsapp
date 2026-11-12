import { pool } from "../db";
import { enc } from "../crypto";

export interface Usuario {
  id: string;
  phone: string;
  nome: string | null;
  status: string;
  timezone: string;
  plano: string;
  assinatura_ate: string | null;
  last_interaction_at: string | null;
  pref_resposta: string | null;   // 'audio' | 'texto' | 'ambos' | null (ainda não escolheu)
  pref_perguntada: boolean;       // já perguntamos a preferência ao menos uma vez
  crm_ativo: boolean;             // (legado) liga CRM
  crm_email: string | null;       // email da conta do cliente no CRM (vincula o dono dos leads)
}

/**
 * Gera variantes de um número BR para tolerar o 9º dígito do celular.
 * Ex.: 11999990001 (12) <-> 11999990001 (13). Também devolve o próprio número.
 * Funciona para BR (DDI 55 + DDD 2 dígitos). Outros países: retorna só o número.
 */
export function variantesTelefone(phone: string): string[] {
  const p = String(phone || "").replace(/[^\d]/g, "");
  const set = new Set<string>([p]);
  if (p.startsWith("55")) {
    const ddd = p.slice(2, 4);
    const resto = p.slice(4);
    if (resto.length === 8) set.add(`55${ddd}9${resto}`);          // adiciona o 9
    if (resto.length === 9 && resto.startsWith("9")) set.add(`55${ddd}${resto.slice(1)}`); // remove o 9
  }
  return [...set];
}

/**
 * Forma CANÔNICA do telefone para ARMAZENAR (evita duplicidade pelo 9º dígito).
 * BR celular: sempre COM o 9 (13 dígitos). Demais: só dígitos.
 */
export function canonicalPhone(phone: string): string {
  const p = String(phone || "").replace(/[^\d]/g, "");
  if (p.startsWith("55")) {
    const ddd = p.slice(2, 4);
    let resto = p.slice(4);
    if (resto.length === 8) resto = `9${resto}`; // adiciona o 9 (canônico)
    return `55${ddd}${resto}`;
  }
  return p;
}

/**
 * Procura um usuário existente por QUALQUER variante do telefone (9º dígito).
 * Usado no cadastro para impedir contas duplicadas no mesmo número.
 */
export async function acharUsuarioPorVariante(phone: string): Promise<{ id: string; phone: string; nome: string | null } | null> {
  const variantes = variantesTelefone(phone);
  const { rows } = await pool.query(
    `SELECT id, phone, nome FROM usuarios WHERE phone = ANY($1) ORDER BY created_at ASC LIMIT 1`,
    [variantes]
  );
  return rows[0] ?? null;
}

/**
 * Retorna o usuário SE estiver autorizado (cadastrado, ativo e assinatura válida).
 * É o gate da allowlist: quem não passa aqui não recebe resposta.
 * Tolerante ao 9º dígito do celular brasileiro.
 * DETERMINÍSTICO: se houver mais de um match (não deveria), sempre devolve o mesmo
 * (o mais recentemente ativo), evitando respostas "trocando" de conta.
 */
export async function getUsuarioAutorizado(phone: string): Promise<Usuario | null> {
  const variantes = variantesTelefone(phone);
  const { rows } = await pool.query<Usuario>(
    `SELECT id, phone, nome, status, timezone, plano, assinatura_ate, last_interaction_at, pref_resposta, pref_perguntada, crm_ativo, crm_email
       FROM usuarios
      WHERE phone = ANY($1)
        AND status = 'ativo'
        AND (assinatura_ate IS NULL OR assinatura_ate >= current_date)
      ORDER BY last_interaction_at DESC NULLS LAST, created_at ASC
      LIMIT 1`,
    [variantes]
  );
  return rows[0] ?? null;
}

/** Marca interação (mantém a janela de 24h quente para lembretes). */
export async function marcarInteracao(userId: string): Promise<void> {
  await pool.query(`UPDATE usuarios SET last_interaction_at = now() WHERE id = $1`, [userId]);
}

/** Registra mensagem (memória + auditoria). */
export async function registrarMensagem(
  userId: string | null,
  phone: string,
  direcao: "in" | "out",
  tipo: string,
  conteudo: string | null,
  intent?: string,
  provider?: string
): Promise<void> {
  await pool.query(
    `INSERT INTO mensagens (user_id, phone, direcao, tipo, conteudo, intent, provider)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [userId, phone, direcao, tipo, enc(conteudo), intent ?? null, provider ?? null]
  );
}
