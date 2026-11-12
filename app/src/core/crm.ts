import axios, { AxiosRequestConfig } from "axios";
import { config } from "../config";
import { log } from "../log";

/**
 * Cliente do CRM natela-control.
 * Autenticação preferencial: API KEY (header X-API-Key) — robusta e revogável.
 * Fallback: login com e-mail/senha do usuário-bot (compatibilidade).
 */
let tokenCache: string | null = null;

function temApiKey(): boolean {
  return Boolean((config as any).CRM_API_KEY);
}

async function login(): Promise<string | null> {
  try {
    const r = await axios.post(
      `${config.CRM_API_URL}/api/auth/login`,
      { email: config.CRM_BOT_EMAIL, password: config.CRM_BOT_SENHA },
      { timeout: 15_000, headers: { "Content-Type": "application/json" } }
    );
    tokenCache = r.data?.token ?? null;
    return tokenCache;
  } catch (e: any) {
    log("warn", "crm: login falhou", { err: e?.response?.data || String(e) });
    return null;
  }
}

/**
 * Requisição autenticada ao CRM. Usa API key se disponível; senão, login+Bearer.
 * Em 401 com login, tenta relogar uma vez.
 */
async function crmRequest<T = any>(method: string, path: string, data?: unknown): Promise<{ ok: boolean; status?: number; data?: T; erro?: string }> {
  if (!config.CRM_API_URL) return { ok: false, erro: "crm_nao_configurado" };
  const url = `${config.CRM_API_URL}${path}`;

  for (let tentativa = 0; tentativa < 2; tentativa++) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (temApiKey()) {
      headers["X-API-Key"] = (config as any).CRM_API_KEY;
    } else {
      if (!tokenCache) { const t = await login(); if (!t) return { ok: false, erro: "crm_login_falhou" }; }
      headers["Authorization"] = `Bearer ${tokenCache}`;
    }
    try {
      const cfg: AxiosRequestConfig = { method: method as any, url, headers, timeout: 20_000 };
      if (data !== undefined) cfg.data = data;
      const r = await axios(cfg);
      return { ok: true, status: r.status, data: r.data as T };
    } catch (e: any) {
      const status = e?.response?.status;
      // só reloga se estiver no modo login (API key não expira)
      if (status === 401 && !temApiKey() && tentativa === 0) { tokenCache = null; continue; }
      const erro = e?.response?.data?.error || String(e?.message || e);
      log("warn", "crm: request falhou", { method, path, status, erro });
      return { ok: false, status, erro };
    }
  }
  return { ok: false, erro: "crm_indisponivel" };
}

/** Testa a integração com o CRM (usado pelo painel). */
export async function statusCRM(): Promise<{ ok: boolean; modo: "api_key" | "login" | "off"; total_leads?: number; erro?: string }> {
  if (!config.CRM_API_URL) return { ok: false, modo: "off", erro: "CRM_API_URL não configurado" };
  const modo = temApiKey() ? "api_key" : (config.CRM_BOT_EMAIL ? "login" : "off");
  if (modo === "off") return { ok: false, modo: "off", erro: "Sem API key nem login configurados" };
  const r = await crmRequest("get", "/api/leads?limit=1");
  if (!r.ok) return { ok: false, modo, erro: r.erro };
  const total = (r.data as any)?.total;
  return { ok: true, modo, total_leads: typeof total === "number" ? total : undefined };
}

// ──────────────────────────────────────────────────────────────
// Criar lead
// ──────────────────────────────────────────────────────────────
export interface NovoLead {
  nome: string;
  telefone: string;
  interesse?: string | null;
  valor?: number | null;
  pagamento?: string | null;
  owner_email?: string | null;
  // wizard
  empreendimento_id?: string | null;
  empreendimento_nome?: string | null;
  captacao_origem?: string | null;
  notes?: string | null;
}
export interface ResultadoLead { ok: boolean; id?: string; erro?: string; }

export async function criarLead(lead: NovoLead): Promise<ResultadoLead> {
  const payload: Record<string, unknown> = {
    name: lead.nome,
    phone: lead.telefone.replace(/\D/g, ""),
    segment: "warm",
    captacao_origem: (lead.captacao_origem && lead.captacao_origem.trim()) ? lead.captacao_origem.slice(0, 100) : "assistente-whatsapp",
    status: "new",
  };
  if (lead.empreendimento_id) payload.empreendimento_id = lead.empreendimento_id;
  if (lead.empreendimento_nome) payload.empreendimento = String(lead.empreendimento_nome).slice(0, 200);
  else if (lead.interesse) payload.empreendimento = String(lead.interesse).slice(0, 200);
  if (lead.valor && lead.valor > 0) payload.entry_value = lead.valor;
  const notas = lead.notes || (lead.pagamento ? `Forma de pagamento: ${lead.pagamento}` : null);
  if (notas) payload.notes = String(notas).slice(0, 2000);
  if (lead.owner_email) payload.owner_email = lead.owner_email;

  const r = await crmRequest("post", "/api/leads", payload);
  if (r.ok) return { ok: true, id: (r.data as any)?.id };
  return { ok: false, erro: r.erro };
}

// ──────────────────────────────────────────────────────────────
// Gestão de leads (listar / buscar / status / anotar)
// ──────────────────────────────────────────────────────────────
export interface LeadResumo {
  id: string;
  name: string;
  phone: string;
  status: string;
  segment: string;
  empreendimento: string | null;
  entry_value: number | null;
}

const STATUS_MAP: Record<string, string> = {
  novo: "new", new: "new",
  contatado: "contacted", contato: "contacted", contactado: "contacted",
  visita: "visiting", visitando: "visiting", "em visita": "visiting",
  negociando: "negotiating", negociacao: "negotiating", "negociação": "negotiating", proposta: "negotiating",
  fechado: "closed", ganho: "closed", vendido: "closed", fechou: "closed",
  perdido: "lost", perdeu: "lost",
};
export function normalizarStatus(txt?: string | null): string | null {
  if (!txt) return null;
  const t = txt.toLowerCase().trim();
  if (STATUS_MAP[t]) return STATUS_MAP[t];
  for (const k of Object.keys(STATUS_MAP)) if (t.includes(k)) return STATUS_MAP[k];
  return null;
}
export function statusPt(en: string): string {
  const m: Record<string, string> = { new: "novo", contacted: "contatado", visiting: "em visita", negotiating: "negociando", closed: "fechado ✅", lost: "perdido" };
  return m[en] || en;
}

/** Lista leads de um assinante (owner_email), opcionalmente filtrando status/busca. */
export async function listarLeads(ownerEmail: string, opts: { status?: string; search?: string; limit?: number } = {}): Promise<{ ok: boolean; leads?: LeadResumo[]; total?: number; erro?: string }> {
  const qs = new URLSearchParams();
  qs.set("owner_email", ownerEmail);
  qs.set("limit", String(opts.limit || 20));
  if (opts.status) qs.set("status", opts.status);
  if (opts.search) qs.set("search", opts.search);
  const r = await crmRequest("get", `/api/leads?${qs.toString()}`);
  if (!r.ok) return { ok: false, erro: r.erro };
  const leads = ((r.data as any)?.leads || []) as LeadResumo[];
  return { ok: true, leads, total: (r.data as any)?.total ?? leads.length };
}

/** Acha o melhor lead de um assinante por nome/telefone (termo livre). */
export async function buscarLead(ownerEmail: string, termo: string): Promise<{ ok: boolean; lead?: LeadResumo; varios?: LeadResumo[]; erro?: string }> {
  const r = await listarLeads(ownerEmail, { search: termo, limit: 10 });
  if (!r.ok) return { ok: false, erro: r.erro };
  const leads = r.leads || [];
  if (leads.length === 0) return { ok: false, erro: "nao_encontrado" };
  if (leads.length === 1) return { ok: true, lead: leads[0] };
  return { ok: true, lead: leads[0], varios: leads };
}

/** Atualiza o status de um lead (status já em inglês do enum). */
export async function atualizarStatusLead(leadId: string, statusEn: string): Promise<{ ok: boolean; erro?: string }> {
  const r = await crmRequest("patch", `/api/leads/${leadId}/status`, { status: statusEn });
  return r.ok ? { ok: true } : { ok: false, erro: r.erro };
}

/** Registra uma interação/nota no lead. */
export async function anotarLead(leadId: string, texto: string): Promise<{ ok: boolean; erro?: string }> {
  const r = await crmRequest("post", `/api/leads/${leadId}/interactions`, { type: "note", description: texto.slice(0, 2000) });
  return r.ok ? { ok: true } : { ok: false, erro: r.erro };
}

// ──────────────────────────────────────────────────────────────
// Pagamentos
// ──────────────────────────────────────────────────────────────
const METODO_MAP: Record<string, string> = {
  pix: "pix", boleto: "boleto",
  cartao: "cartao", "cartão": "cartao", credito: "cartao", "crédito": "cartao", debito: "cartao", "débito": "cartao",
  dinheiro: "dinheiro", especie: "dinheiro", "espécie": "dinheiro", vista: "dinheiro",
};
export function normalizarMetodo(txt?: string | null): string | null {
  if (!txt) return null;
  const t = txt.toLowerCase().trim();
  if (METODO_MAP[t]) return METODO_MAP[t];
  for (const k of Object.keys(METODO_MAP)) if (t.includes(k)) return METODO_MAP[k];
  return null;
}
export interface PagamentoResumo { id: string; amount: number; payment_method: string; payment_date: string; lead_name: string | null; reference: string | null; }

/** Lista pagamentos de um corretor (opcional: de um lead, período). */
export async function listarPagamentos(ownerEmail: string, opts: { leadAlvo?: string; start?: string; end?: string } = {}): Promise<{ ok: boolean; pagamentos?: PagamentoResumo[]; total?: number; erro?: string }> {
  const qs = new URLSearchParams();
  qs.set("owner_email", ownerEmail);
  if (opts.leadAlvo) {
    const b = await buscarLead(ownerEmail, opts.leadAlvo);
    if (b.ok && b.lead) qs.set("lead_id", b.lead.id);
  }
  if (opts.start) qs.set("start_date", opts.start);
  if (opts.end) qs.set("end_date", opts.end);
  const r = await crmRequest("get", `/api/payments?${qs.toString()}`);
  if (!r.ok) return { ok: false, erro: r.erro };
  const pagamentos = ((r.data as any) || []).map((x: any) => ({ id: x.id, amount: Number(x.amount), payment_method: x.payment_method, payment_date: x.payment_date, lead_name: x.lead_name, reference: x.reference }));
  const total = pagamentos.reduce((s: number, x: PagamentoResumo) => s + (x.amount || 0), 0);
  return { ok: true, pagamentos, total };
}

// ──────────────────────────────────────────────────────────────
// Agenda (agendamentos)
// ──────────────────────────────────────────────────────────────
export interface AgendaItem { id: string; title: string; scheduled_at: string; lead_name: string | null; status: string; confirmation_status: string | null; }

/** Cria um agendamento (opcionalmente vinculado a um lead achado por termo). */
export async function criarAgendamento(ownerEmail: string, a: { title: string; scheduledAtIso: string; leadAlvo?: string; description?: string }): Promise<{ ok: boolean; lead?: LeadResumo; erro?: string }> {
  const payload: Record<string, unknown> = { title: a.title.slice(0, 200), scheduled_at: a.scheduledAtIso };
  let lead: LeadResumo | undefined;
  if (a.leadAlvo) {
    const b = await buscarLead(ownerEmail, a.leadAlvo);
    if (b.ok && b.lead) { lead = b.lead; payload.lead_id = b.lead.id; }
  }
  if (a.description) payload.description = a.description.slice(0, 1000);
  const r = await crmRequest("post", "/api/calendar", payload);
  return r.ok ? { ok: true, lead } : { ok: false, lead, erro: r.erro };
}

/** Lista agendamentos de um corretor num intervalo (ISO). */
export async function listarAgendamentos(ownerEmail: string, opts: { start?: string; end?: string } = {}): Promise<{ ok: boolean; itens?: AgendaItem[]; erro?: string }> {
  const qs = new URLSearchParams();
  qs.set("owner_email", ownerEmail);
  if (opts.start) qs.set("start", opts.start);
  if (opts.end) qs.set("end", opts.end);
  const r = await crmRequest("get", `/api/calendar?${qs.toString()}`);
  if (!r.ok) return { ok: false, erro: r.erro };
  const itens = ((r.data as any) || []).map((x: any) => ({ id: x.id, title: x.title, scheduled_at: x.scheduled_at, lead_name: x.lead_name, status: x.status, confirmation_status: x.confirmation_status }));
  return { ok: true, itens };
}

// ──────────────────────────────────────────────────────────────
// Notificações de agendamento (fila no CRM, consumida pelo job do bot)
// ──────────────────────────────────────────────────────────────
export interface NotifAgenda { appointment_id: string; event: "created" | "confirmed" | "reschedule" | "reminder"; owner_email: string; owner_name: string | null; lead_name: string | null; lead_phone: string | null; title: string; scheduled_at: string; reschedule_reason: string | null; }

export async function getNotificacoesAgenda(): Promise<NotifAgenda[]> {
  const r = await crmRequest("get", "/api/integrations/appointment-notifications");
  if (!r.ok) return [];
  return ((r.data as any)?.eventos || []) as NotifAgenda[];
}

export async function ackNotificacaoAgenda(appointmentId: string, event: string): Promise<void> {
  await crmRequest("post", `/api/integrations/appointment-notifications/${appointmentId}/ack`, { event });
}

// ──────────────────────────────────────────────────────────────
// Empreendimentos / Parcelas (usados pelos wizards)
// ──────────────────────────────────────────────────────────────
export async function listarEmpreendimentos(): Promise<{ id: string; nome: string }[]> {
  const r = await crmRequest("get", "/api/empreendimentos/all");
  if (!r.ok) return [];
  const arr = Array.isArray(r.data) ? r.data : ((r.data as any)?.empreendimentos || []);
  return arr.map((e: any) => ({ id: e.id, nome: e.nome })).filter((e: any) => e.id && e.nome);
}

/** Registra pagamento direto (já com o lead_id resolvido). */
export async function registrarPagamentoDireto(leadId: string, amount: number, method: string, date?: string): Promise<{ ok: boolean; erro?: string }> {
  const r = await crmRequest("post", "/api/payments", {
    lead_id: leadId, amount, payment_method: method, payment_date: date || new Date().toISOString().slice(0, 10),
  });
  return r.ok ? { ok: true } : { ok: false, erro: r.erro };
}

/** Gera o cronograma de parcelas no CRM (entrada + N parcelas). */
export async function gerarParcelas(leadId: string, p: { entrada_valor?: number; entrada_vencimento?: string; num_parcelas: number; valor_parcela: number; primeiro_vencimento: string; intervalo_dias?: number }): Promise<{ ok: boolean; erro?: string }> {
  const body: Record<string, unknown> = {
    lead_id: leadId,
    num_parcelas: p.num_parcelas,
    valor_parcela: p.valor_parcela,
    primeiro_vencimento: p.primeiro_vencimento,
    intervalo_dias: p.intervalo_dias || 30,
  };
  if (p.entrada_valor && p.entrada_valor > 0) { body.entrada_valor = p.entrada_valor; if (p.entrada_vencimento) body.entrada_vencimento = p.entrada_vencimento; }
  const r = await crmRequest("post", "/api/parcelas/gerar", body);
  return r.ok ? { ok: true } : { ok: false, erro: r.erro };
}

// ──────────────────────────────────────────────────────────────
// Relatório Excel (download binário → base64 p/ enviar no WhatsApp)
// ──────────────────────────────────────────────────────────────
export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export async function baixarRelatorioExcel(ownerEmail: string): Promise<{ ok: boolean; base64?: string; filename?: string; erro?: string }> {
  if (!config.CRM_API_URL) return { ok: false, erro: "crm_nao_configurado" };
  if (!temApiKey()) return { ok: false, erro: "sem_api_key" };
  try {
    const url = `${config.CRM_API_URL}/api/reports/excel-export?owner_email=${encodeURIComponent(ownerEmail)}`;
    const r = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 30_000,
      headers: { "X-API-Key": (config as any).CRM_API_KEY },
    });
    const base64 = Buffer.from(r.data).toString("base64");
    const filename = `relatorio_${new Date().toISOString().slice(0, 10)}.xlsx`;
    return { ok: true, base64, filename };
  } catch (e: any) {
    log("warn", "crm: baixarRelatorioExcel falhou", { err: e?.response?.status || String(e) });
    return { ok: false, erro: String(e?.response?.status || e?.message || e) };
  }
}

// ──────────────────────────────────────────────────────────────
// Vendas / Meta / Ranking / Leads parados / Duplicado (bot)
// ──────────────────────────────────────────────────────────────
export async function resumoVendas(ownerEmail: string): Promise<{ ok: boolean; por_status?: any[]; fechados_mes?: { n: number; total: number }; erro?: string }> {
  const r = await crmRequest("get", `/api/reports/resumo-bot?owner_email=${encodeURIComponent(ownerEmail)}`);
  if (!r.ok) return { ok: false, erro: r.erro };
  return { ok: true, ...(r.data as any) };
}

export async function metaProgresso(ownerEmail: string): Promise<{ ok: boolean; goal?: any; actual?: any; erro?: string }> {
  const r = await crmRequest("get", `/api/goals/progress-by-email?owner_email=${encodeURIComponent(ownerEmail)}`);
  if (!r.ok) return { ok: false, erro: r.erro };
  return { ok: true, ...(r.data as any) };
}

export async function rankingPosicao(ownerEmail: string): Promise<{ ok: boolean; top?: any[]; posicao?: number | null; vendas?: number; erro?: string }> {
  const r = await crmRequest("get", `/api/ranking/posicao?owner_email=${encodeURIComponent(ownerEmail)}&period=month`);
  if (!r.ok) return { ok: false, erro: r.erro };
  return { ok: true, ...(r.data as any) };
}

export interface LeadParado { id: string; name: string; status: string; dias_parado: number; owner_email: string }
export async function leadsParados(dias = 5): Promise<LeadParado[]> {
  const r = await crmRequest("get", `/api/reports/leads-parados?days=${dias}`);
  if (!r.ok || !Array.isArray(r.data)) return [];
  return r.data as LeadParado[];
}

/** Baixa o modelo de contrato do corretor (PDF) cadastrado no CRM; null se não tiver. */
export async function baixarTemplateContrato(ownerEmail: string): Promise<Buffer | null> {
  if (!config.CRM_API_URL || !temApiKey()) return null;
  try {
    const url = `${config.CRM_API_URL}/api/contract-template/by-email?owner_email=${encodeURIComponent(ownerEmail)}`;
    const r = await axios.get(url, { responseType: "arraybuffer", timeout: 20_000, headers: { "X-API-Key": (config as any).CRM_API_KEY } });
    const buf = Buffer.from(r.data);
    return buf.length > 1000 ? buf : null;
  } catch {
    return null; // sem modelo próprio → usa o padrão
  }
}

export async function checarDuplicado(phone: string): Promise<{ duplicado: boolean; nome?: string }> {
  const r = await crmRequest("post", "/api/leads/check-duplicate", { phone });
  const dups = (r.data as any)?.duplicates;
  if (r.ok && Array.isArray(dups) && dups.length > 0) return { duplicado: true, nome: dups[0]?.name };
  return { duplicado: false };
}
