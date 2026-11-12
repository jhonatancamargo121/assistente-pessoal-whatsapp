import { pool } from "../db";

/** Data local (America/Sao_Paulo, via TZ do container) no formato YYYY-MM-DD, com offset de dias. */
function diaSP(offset = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toLocaleDateString("sv-SE"); // sv-SE => YYYY-MM-DD
}

/** Sequência (streak) de dias consecutivos com check-in, contando até hoje (ou ontem, se hoje ainda não marcou). */
async function streakHabito(habitoId: string): Promise<number> {
  const { rows } = await pool.query<{ dia: string }>(
    `SELECT dia::text AS dia FROM habito_checkins WHERE habito_id=$1 ORDER BY dia DESC LIMIT 400`,
    [habitoId]
  );
  const set = new Set(rows.map((r) => r.dia));
  let off: number | null = set.has(diaSP(0)) ? 0 : set.has(diaSP(-1)) ? -1 : null;
  if (off === null) return 0;
  let streak = 0;
  while (set.has(diaSP(off))) { streak++; off--; }
  return streak;
}

export async function criarHabito(userId: string, nome: string): Promise<boolean> {
  const n = (nome || "").trim();
  if (!n) return false;
  await pool.query(`INSERT INTO habitos (user_id, nome) VALUES ($1,$2)`, [userId, n]);
  return true;
}

export interface RegistroHabito { nome: string; streak: number; jaMarcado: boolean }

/** Marca o hábito de hoje (cria check-in) e devolve a sequência. alvo = trecho do nome; sem alvo usa o mais recente. */
export async function registrarHabito(userId: string, alvo?: string | null): Promise<RegistroHabito | null> {
  let rows;
  if (alvo && alvo.trim()) {
    ({ rows } = await pool.query(
      `SELECT id, nome FROM habitos WHERE user_id=$1 AND ativo AND nome ILIKE '%'||$2||'%' ORDER BY created_at DESC LIMIT 1`,
      [userId, alvo.trim()]
    ));
  } else {
    ({ rows } = await pool.query(`SELECT id, nome FROM habitos WHERE user_id=$1 AND ativo ORDER BY created_at DESC LIMIT 1`, [userId]));
  }
  if (!rows[0]) return null;
  const h = rows[0];
  const ins = await pool.query(
    `INSERT INTO habito_checkins (habito_id, dia) VALUES ($1,$2) ON CONFLICT (habito_id, dia) DO NOTHING RETURNING id`,
    [h.id, diaSP(0)]
  );
  const jaMarcado = !ins.rows[0];
  const streak = await streakHabito(h.id);
  return { nome: h.nome, streak, jaMarcado };
}

export async function listarHabitos(userId: string): Promise<{ nome: string; streak: number; hoje: boolean }[]> {
  const { rows } = await pool.query(`SELECT id, nome FROM habitos WHERE user_id=$1 AND ativo ORDER BY created_at`, [userId]);
  const out = [];
  for (const h of rows) {
    const streak = await streakHabito(h.id);
    const hoje = (await pool.query(`SELECT 1 FROM habito_checkins WHERE habito_id=$1 AND dia=$2`, [h.id, diaSP(0)])).rows.length > 0;
    out.push({ nome: h.nome, streak, hoje });
  }
  return out;
}
