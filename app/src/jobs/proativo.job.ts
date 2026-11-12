import { pool } from "../db";
import { sendText } from "../evolution/client";
import { leadsParados } from "../core/crm";
import { config } from "../config";
import { log } from "../log";

/**
 * Job PROATIVO (anti-ban por construção):
 *  - só envia para usuário ATIVO que interagiu nos últimos 14 dias
 *  - tudo é OPT-IN (resumo diário/semanal) ou utilitário direto (conta a vencer, lead parado)
 *  - dedupe via lembretes_enviados (ref_tipo, ref_id, ocorrencia) — nunca repete no dia
 * Horários no FUSO DO USUÁRIO: bom-dia 07h · contas 09h · leads parados 09h (seg-sex) · semanal dom 19h.
 */
const TICK_MS = 10 * 60_000;
let timer: NodeJS.Timeout | null = null;
let rodando = false;

function brl(v: number): string { return Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }); }

function agoraLocal(tz: string): { hora: number; diaSemana: number; diaMes: number; dataISO: string } {
  const tzv = tz || config.APP_TIMEZONE;
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tzv, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false, weekday: "short" }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
  const wd = ({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 } as Record<string, number>)[get("weekday")] ?? 0;
  return { hora: Number(get("hour")), diaSemana: wd, diaMes: Number(get("day")), dataISO: `${get("year")}-${get("month")}-${get("day")}` };
}

/** Marca envio único (false = já tinha sido enviado). */
async function marcarUnico(userId: string, refTipo: string, refId: string, ocorrencia: string): Promise<boolean> {
  try {
    const r = await pool.query(
      `INSERT INTO lembretes_enviados (user_id, ref_tipo, ref_id, ocorrencia) VALUES ($1,$2,$3,$4)
       ON CONFLICT (ref_tipo, ref_id, ocorrencia) DO NOTHING RETURNING id`,
      [userId, refTipo, refId, ocorrencia + "T12:00:00Z"]);
    return (r.rowCount || 0) > 0;
  } catch { return false; }
}

async function resumoDiario(u: any, dataISO: string): Promise<string> {
  const tz = u.timezone || config.APP_TIMEZONE;
  const [tarefas, rotinas, fin, contas] = await Promise.all([
    pool.query(`SELECT titulo, due_at FROM tarefas WHERE user_id=$1 AND status='pendente' AND due_at::date = $2::date ORDER BY due_at`, [u.id, dataISO]),
    pool.query(`SELECT titulo, hora, hora_fim FROM rotinas WHERE user_id=$1 AND $2 = ANY(dias_semana) ORDER BY hora`, [u.id, new Date(dataISO + "T12:00:00Z").getUTCDay()]),
    pool.query(`SELECT COALESCE(SUM(CASE WHEN tipo='entrada' THEN valor END),0) ent, COALESCE(SUM(CASE WHEN tipo='saida' THEN valor END),0) sai FROM lancamentos WHERE user_id=$1 AND date_trunc('month', ocorrido_em)=date_trunc('month', current_date)`, [u.id]),
    pool.query(`SELECT nome, valor, dia_vencimento FROM contas_fixas WHERE user_id=$1 AND ativo AND dia_vencimento BETWEEN $2 AND $2+2`, [u.id, Number(dataISO.slice(8, 10))]),
  ]);
  const ls: string[] = [`🌅 *Bom dia${u.nome ? ", " + String(u.nome).split(" ")[0] : ""}!* Seu resumo de hoje:`];
  if (rotinas.rows.length) ls.push(`\n🗓️ *Agenda:*\n${rotinas.rows.map((r: any) => `• ${String(r.hora).slice(0, 5)}${r.hora_fim ? "–" + String(r.hora_fim).slice(0, 5) : ""} ${r.titulo}`).join("\n")}`);
  if (tarefas.rows.length) ls.push(`\n📋 *Tarefas:*\n${tarefas.rows.map((t: any) => `• ${t.titulo} (${new Date(t.due_at).toLocaleTimeString("pt-BR", { timeZone: tz, hour: "2-digit", minute: "2-digit" })})`).join("\n")}`);
  if (!rotinas.rows.length && !tarefas.rows.length) ls.push(`\n✨ Dia livre — nada agendado.`);
  const f = fin.rows[0];
  ls.push(`\n💰 Mês: ${brl(Number(f.ent))} entradas · ${brl(Number(f.sai))} gastos`);
  if (contas.rows.length) ls.push(`\n🧾 *Contas chegando:*\n${contas.rows.map((c: any) => `• ${c.nome} — dia ${c.dia_vencimento}${c.valor ? ` (${brl(Number(c.valor))})` : ""}`).join("\n")}`);
  ls.push(`\nBom dia e bora! 💪 _(pra parar: "desativa o resumo diário")_`);
  return ls.join("\n");
}

async function resumoSemanal(u: any): Promise<string> {
  const [fin, feitas] = await Promise.all([
    pool.query(`SELECT COALESCE(SUM(CASE WHEN tipo='entrada' THEN valor END),0) ent, COALESCE(SUM(CASE WHEN tipo='saida' THEN valor END),0) sai FROM lancamentos WHERE user_id=$1 AND ocorrido_em >= now() - interval '7 days'`, [u.id]),
    pool.query(`SELECT count(*) n FROM tarefas WHERE user_id=$1 AND status='concluida' AND created_at >= now() - interval '7 days'`, [u.id]),
  ]);
  const f = fin.rows[0];
  const saldo = Number(f.ent) - Number(f.sai);
  return `📊 *Seu balanço da semana:*\n\n💵 Entradas: ${brl(Number(f.ent))}\n💸 Gastos: ${brl(Number(f.sai))}\n${saldo >= 0 ? "✅" : "🚨"} Saldo: *${brl(saldo)}*\n✔️ Tarefas concluídas: ${feitas.rows[0].n}\n\nBoa semana! 🚀 _(pra parar: "desativa o resumo semanal")_`;
}

async function tick(): Promise<void> {
  if (rodando) return;
  rodando = true;
  try {
    const { rows: users } = await pool.query(
      `SELECT id, phone, nome, timezone, crm_email, resumo_diario, resumo_semanal FROM usuarios
        WHERE status='ativo' AND last_interaction_at > now() - interval '14 days'`);
    let parados: Awaited<ReturnType<typeof leadsParados>> | null = null;

    for (const u of users) {
      const loc = agoraLocal(u.timezone);
      // 🌅 resumo diário 07h
      if (u.resumo_diario && loc.hora === 7 && (await marcarUnico(u.id, "resumo_diario", u.id, loc.dataISO))) {
        await sendText(u.phone, await resumoDiario(u, loc.dataISO));
        log("info", "proativo: resumo diario enviado", { phone: u.phone });
      }
      // 📊 resumo semanal dom 19h
      if (u.resumo_semanal && loc.diaSemana === 0 && loc.hora === 19 && (await marcarUnico(u.id, "resumo_semanal", u.id, loc.dataISO))) {
        await sendText(u.phone, await resumoSemanal(u));
        log("info", "proativo: resumo semanal enviado", { phone: u.phone });
      }
      // 🧾 contas a vencer (hoje+2d), 09h
      if (loc.hora === 9) {
        const { rows: contas } = await pool.query(
          `SELECT id, nome, valor, dia_vencimento FROM contas_fixas WHERE user_id=$1 AND ativo AND dia_vencimento BETWEEN $2 AND $2+2`,
          [u.id, loc.diaMes]);
        for (const c of contas) {
          if (await marcarUnico(u.id, "conta_aviso", c.id, loc.dataISO.slice(0, 8) + String(c.dia_vencimento).padStart(2, "0"))) {
            const quando = c.dia_vencimento === loc.diaMes ? "vence *HOJE*" : `vence dia *${c.dia_vencimento}*`;
            await sendText(u.phone, `🧾 Lembrete: a conta *${c.nome}* ${quando}${c.valor ? ` (~${brl(Number(c.valor))})` : ""}.\nQuando pagar é só me falar: _"paguei a ${c.nome}"_ 😉`);
            log("info", "proativo: aviso de conta", { phone: u.phone, conta: c.nome });
          }
        }
      }
      // 📣 leads parados (corretor, seg-sex 09h)
      if (u.crm_email && loc.hora === 9 && loc.diaSemana >= 1 && loc.diaSemana <= 5) {
        if (parados === null) parados = await leadsParados(5).catch(() => []);
        const meus = (parados || []).filter((l) => String(l.owner_email || "").toLowerCase() === String(u.crm_email).toLowerCase()).slice(0, 5);
        if (meus.length && (await marcarUnico(u.id, "leads_parados", u.id, loc.dataISO))) {
          const ls = meus.map((l) => `• *${l.name}* — ${l.dias_parado} dia(s) sem contato`);
          await sendText(u.phone, `📣 *Leads esperando retorno:*\n${ls.join("\n")}\n\nVale um follow-up hoje 😉 _(ex: "anota no lead ${meus[0].name.split(" ")[0]} que liguei")_`);
          log("info", "proativo: leads parados", { phone: u.phone, qtd: meus.length });
        }
      }
    }
  } catch (e) {
    log("warn", "proativo: tick falhou", { e: String(e) });
  } finally {
    rodando = false;
  }
}

export function startProativoJob(): void {
  if (timer) return;
  timer = setInterval(tick, TICK_MS);
  setTimeout(tick, 20_000);
  log("info", "job proativo iniciado", { tickMs: TICK_MS });
}
export function stopProativoJob(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
