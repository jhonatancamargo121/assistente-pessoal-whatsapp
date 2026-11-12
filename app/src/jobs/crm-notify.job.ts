/**
 * Job: notificações de agendamento do CRM → WhatsApp do corretor.
 * Faz polling da fila no CRM (via API key), e para cada evento:
 *  - resolve o e-mail do corretor → assinante ATIVO do bot (usuarios.crm_email)
 *  - SÓ notifica corretores que TÊM acesso ao bot; os demais são "ack" em silêncio
 *  - envia a mensagem e dá ack pra não repetir
 */
import { pool } from "../db";
import { sendText } from "../evolution/client";
import { getNotificacoesAgenda, ackNotificacaoAgenda, type NotifAgenda } from "../core/crm";
import { config } from "../config";
import { log } from "../log";

const TICK_MS = 60_000;
let timer: NodeJS.Timeout | null = null;
let rodando = false;

function fmt(iso: string): string {
  try {
    return new Date(iso).toLocaleString("pt-BR", { timeZone: config.APP_TIMEZONE, weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  } catch { return iso; }
}

function montarMensagem(ev: NotifAgenda): string {
  const quem = ev.lead_name ? `*${ev.lead_name}*` : "cliente";
  const quando = fmt(ev.scheduled_at);
  switch (ev.event) {
    case "created":
      return `📅 *Novo agendamento*\n${ev.title} com ${quem}\n🗓️ ${quando}${ev.lead_phone ? `\n📱 ${ev.lead_phone}` : ""}`;
    case "confirmed":
      return `✅ *Visita confirmada!*\n${quem} confirmou: ${ev.title}\n🗓️ ${quando}`;
    case "reschedule":
      return `🔄 *Pedido de remarcação*\n${quem} quer remarcar: ${ev.title}\n🗓️ era ${quando}${ev.reschedule_reason ? `\n💬 Motivo: ${ev.reschedule_reason}` : ""}\nEntre em contato pra reagendar.`;
    case "reminder":
      return `⏰ *Lembrete de visita*\nDaqui a pouco: ${ev.title} com ${quem}\n🗓️ ${quando}${ev.lead_phone ? `\n📱 ${ev.lead_phone}` : ""}`;
    default:
      return `📅 ${ev.title} — ${quando}`;
  }
}

/** Acha o assinante ATIVO do bot vinculado ao e-mail do corretor no CRM. */
async function corretorComBot(ownerEmail: string): Promise<{ phone: string } | null> {
  try {
    const { rows } = await pool.query(
      `SELECT phone FROM usuarios WHERE LOWER(crm_email) = LOWER($1) AND status='ativo' LIMIT 1`,
      [ownerEmail]
    );
    return rows[0] ? { phone: rows[0].phone } : null;
  } catch {
    return null;
  }
}

async function tick(): Promise<void> {
  if (rodando) return;
  rodando = true;
  try {
    const eventos = await getNotificacoesAgenda();
    for (const ev of eventos) {
      if (!ev.owner_email) { await ackNotificacaoAgenda(ev.appointment_id, ev.event); continue; }
      const corretor = await corretorComBot(ev.owner_email);
      if (corretor) {
        const ok = await sendText(corretor.phone, montarMensagem(ev));
        log("info", "crm-notify: enviado", { event: ev.event, owner: ev.owner_email, ok });
        // Só dá ack se REALMENTE enviou. Se o WhatsApp do bot estiver fora,
        // mantém na fila pra reenviar no próximo tick (não perde a notificação).
        if (ok) await ackNotificacaoAgenda(ev.appointment_id, ev.event);
      } else {
        // corretor não usa o bot → consome em silêncio (não há pra quem enviar)
        await ackNotificacaoAgenda(ev.appointment_id, ev.event);
      }
    }
  } catch (e) {
    log("warn", "crm-notify: tick falhou", { e: String(e) });
  } finally {
    rodando = false;
  }
}

export function startCrmNotifyJob(): void {
  if (timer) return;
  log("info", "job crm-notify iniciado", { tickMs: TICK_MS });
  timer = setInterval(tick, TICK_MS);
  setTimeout(tick, 8_000);
}

export function stopCrmNotifyJob(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
