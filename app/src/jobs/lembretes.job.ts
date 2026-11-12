/**
 * Motor de lembretes (tick a cada 60s).
 *
 * Regra anti-ban: só manda lembrete PROATIVO para usuário ATIVO
 * (interagiu nas últimas REENGAJAMENTO_HORAS). Usuário dormente →
 * segura o lembrete em pendencias_reengajamento e entrega quando ele voltar.
 */
import { pool } from "../db";
import { config } from "../config";
import { log } from "../log";
import { sendText } from "../evolution/client";

const TICK_MS = 60_000;
let timer: NodeJS.Timeout | null = null;
let rodando = false;

function ativo(lastInteraction: string | null): boolean {
  if (!lastInteraction) return false;
  const horas = (Date.now() - new Date(lastInteraction).getTime()) / 3_600_000;
  return horas <= config.REENGAJAMENTO_HORAS;
}

async function entregarLembrete(
  userId: string,
  phone: string,
  lastInteraction: string | null,
  texto: string,
  ref: { tipo: string; id: string; ocorrencia: Date }
): Promise<void> {
  // idempotência
  const ins = await pool.query(
    `INSERT INTO lembretes_enviados (user_id, ref_tipo, ref_id, ocorrencia)
     VALUES ($1,$2,$3,$4) ON CONFLICT (ref_tipo, ref_id, ocorrencia) DO NOTHING RETURNING id`,
    [userId, ref.tipo, ref.id, ref.ocorrencia]
  );
  if (!ins.rows[0]) return; // já enviado

  if (ativo(lastInteraction)) {
    await sendText(phone, `⏰ ${texto}`);
    log("info", "lembrete enviado", { phone, ref: ref.tipo });
  } else {
    // dormente → segura p/ reengajamento
    await pool.query(`INSERT INTO pendencias_reengajamento (user_id, texto) VALUES ($1,$2)`, [userId, texto]);
    log("info", "lembrete segurado (usuario dormente)", { phone, ref: ref.tipo });
  }
}

async function tick(): Promise<void> {
  if (rodando) return;
  rodando = true;
  try {
    // 0) Agenda rotinas recém-criadas (proxima_ocorrencia ainda nula)
    const novas = await pool.query(`SELECT id FROM rotinas WHERE ativa AND lembrar AND proxima_ocorrencia IS NULL LIMIT 50`);
    for (const n of novas.rows) await reagendarRotina(n.id);

    // 1) Tarefas com lembrete vencido
    const tarefas = await pool.query(
      `SELECT t.id, t.titulo, t.lembrete_at, u.id AS user_id, u.phone, u.last_interaction_at
         FROM tarefas t JOIN usuarios u ON u.id = t.user_id
        WHERE t.status='pendente' AND t.lembrete_at IS NOT NULL AND t.lembrete_at <= now()
          AND u.status='ativo'
        LIMIT 50`
    );
    for (const t of tarefas.rows) {
      await entregarLembrete(t.user_id, t.phone, t.last_interaction_at, `Lembrete: ${t.titulo}`, {
        tipo: "tarefa",
        id: t.id,
        ocorrencia: new Date(t.lembrete_at),
      });
    }

    // 2) Rotinas com ocorrência vencida
    const rotinas = await pool.query(
      `SELECT r.id, r.titulo, r.proxima_ocorrencia, u.id AS user_id, u.phone, u.last_interaction_at
         FROM rotinas r JOIN usuarios u ON u.id = r.user_id
        WHERE r.ativa AND r.lembrar AND r.proxima_ocorrencia IS NOT NULL AND r.proxima_ocorrencia <= now()
          AND u.status='ativo'
        LIMIT 50`
    );
    for (const r of rotinas.rows) {
      await entregarLembrete(r.user_id, r.phone, r.last_interaction_at, `Rotina: ${r.titulo}`, {
        tipo: "rotina",
        id: r.id,
        ocorrencia: new Date(r.proxima_ocorrencia),
      });
      // reagenda próxima ocorrência
      await reagendarRotina(r.id);
    }

    // 3) Avisos de vencimento de assinatura (3 dias antes, 1 dia antes, no dia)
    await avisarVencimentos();
  } catch (err) {
    log("warn", "lembretes: tick falhou", { err: String(err) });
  } finally {
    rodando = false;
  }
}

/**
 * Avisa o ASSINANTE sobre o vencimento da assinatura: 3 dias antes, 1 dia antes e no dia.
 * Idempotente por (ref_tipo, ref_id, ocorrencia) usando lembretes_enviados:
 * ref_id = id do usuário; ocorrencia = a própria data de vencimento; o "marco" (3/1/0)
 * vai embutido no ref_tipo para permitir os 3 avisos distintos.
 */
async function avisarVencimentos(): Promise<void> {
  const marcos: { dias: number; tag: string; msg: (n: string) => string }[] = [
    { dias: 3, tag: "venc3", msg: (n) => `Olá${n}! 🗓️ Sua assinatura do Assistente vence em *3 dias*. Renove para não perder o acesso 🙂` },
    { dias: 1, tag: "venc1", msg: (n) => `Olá${n}! ⏳ Sua assinatura vence *amanhã*. Renove para continuar usando o Assistente 🙏` },
    { dias: 0, tag: "venc0", msg: (n) => `Olá${n}! ⚠️ Sua assinatura *vence hoje*. Renove para manter seu acesso ativo 🙂` },
  ];
  for (const m of marcos) {
    const { rows } = await pool.query(
      `SELECT id, phone, nome, assinatura_ate
         FROM usuarios
        WHERE status='ativo' AND plano<>'admin'
          AND assinatura_ate = (current_date + make_interval(days => $1))::date
        LIMIT 200`,
      [m.dias]
    );
    for (const u of rows) {
      const ins = await pool.query(
        `INSERT INTO lembretes_enviados (user_id, ref_tipo, ref_id, ocorrencia)
         VALUES ($1,$2,$3,$4) ON CONFLICT (ref_tipo, ref_id, ocorrencia) DO NOTHING RETURNING id`,
        [u.id, m.tag, u.id, u.assinatura_ate]
      );
      if (!ins.rows[0]) continue; // já avisado nesse marco
      const nome = u.nome ? " " + String(u.nome).trim().split(/\s+/)[0] : "";
      await sendText(u.phone, m.msg(nome));
      log("info", "aviso de vencimento enviado", { phone: u.phone, marco: m.tag });
    }
  }
}

/** Calcula a próxima ocorrência de uma rotina (próximo dia da semana na hora marcada). */
async function reagendarRotina(rotinaId: string): Promise<void> {
  const { rows } = await pool.query(`SELECT dias_semana, hora FROM rotinas WHERE id=$1`, [rotinaId]);
  if (!rows[0]) return;
  const dias: number[] = rows[0].dias_semana;
  const [hh, mm] = String(rows[0].hora).split(":").map(Number);
  const agora = new Date();
  for (let i = 1; i <= 7; i++) {
    const cand = new Date(agora);
    cand.setDate(agora.getDate() + i);
    cand.setHours(hh, mm, 0, 0);
    if (dias.includes(cand.getDay())) {
      await pool.query(`UPDATE rotinas SET proxima_ocorrencia=$1 WHERE id=$2`, [cand, rotinaId]);
      return;
    }
  }
}

export function startLembretesJob(): void {
  if (timer) return;
  log("info", "job de lembretes iniciado", { tickMs: TICK_MS });
  timer = setInterval(tick, TICK_MS);
  setTimeout(tick, 8_000);
}

export function stopLembretesJob(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
