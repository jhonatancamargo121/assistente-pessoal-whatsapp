import { pool } from "../db";
import type { Usuario } from "./allowlist";
import {
  criarLead, buscarLead, listarEmpreendimentos,
  registrarPagamentoDireto, gerarParcelas, normalizarMetodo, checarDuplicado, baixarTemplateContrato, type LeadResumo,
} from "./crm";
import { responder } from "./reply";
import { sendDocument } from "../evolution/client";
import { extrairDocumento, extrairEndereco, preencherContrato, templateDoCorretor, type DadosCliente } from "./contrato";

/**
 * Wizards conversacionais (multi-passo) para CRIAR LEAD e REGISTRAR PAGAMENTO.
 * O estado fica em usuarios.wizard_state (jsonb). O server checa o wizard ANTES
 * de classificar a mensagem, então cada resposta vai direto pro passo atual.
 */
export interface WizardState {
  tipo: "lead" | "pagamento" | "contrato";
  passo: string;
  dados: any;
  emp?: { id: string; nome: string }[];
  ts?: number; // epoch ms da última atualização (p/ expirar wizard abandonado)
}

const WIZARD_TTL_MS = 20 * 60 * 1000; // 20 min sem responder = wizard expira

const CANCELAR = /^\s*(cancela(r)?|para|parar|deixa( pra l[áa])?|esquece|sair|aborta(r)?)\s*[.!]?\s*$/i;
const SIM = /^\s*(sim|s|confirmo?|confirmar|pode|ok|okay|isso|certo|claro|positivo|👍)\b/i;

function brl(v: number): string { return Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" }); }

async function setWizard(userId: string, st: WizardState | null): Promise<void> {
  if (st) st.ts = Date.now();
  await pool.query(`UPDATE usuarios SET wizard_state=$1 WHERE id=$2`, [st ? JSON.stringify(st) : null, userId]);
}
export async function getWizard(userId: string): Promise<WizardState | null> {
  try {
    const { rows } = await pool.query(`SELECT wizard_state FROM usuarios WHERE id=$1`, [userId]);
    const st = (rows[0]?.wizard_state as WizardState) || null;
    if (!st) return null;
    // Expira wizard abandonado: não sequestra mensagens futuras do usuário.
    if (typeof st.ts === "number" && Date.now() - st.ts > WIZARD_TTL_MS) {
      await clearWizard(userId);
      return null;
    }
    return st;
  } catch { return null; }
}
export async function clearWizard(userId: string): Promise<void> {
  await pool.query(`UPDATE usuarios SET wizard_state=NULL WHERE id=$1`, [userId]);
}

// ── Datas (parser BR simples, com validação de data REAL) ─────
/** Valida que ano-mês-dia é uma data real (rejeita 31/06, 30/02 etc.). */
function dataValida(y: number, mo: number, d: number): boolean {
  const dt = new Date(y, mo - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d;
}
function iso(y: number, mo: number, d: number): string {
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
function dataBR(texto: string): string | null {
  const t = texto.trim().toLowerCase();
  const now = new Date();
  let mm = t.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (mm) { const y = +mm[1], mo = +mm[2], d = +mm[3]; return dataValida(y, mo, d) ? iso(y, mo, d) : null; }
  let m = t.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
  if (m) {
    const d = +m[1], mo = +m[2]; let y = m[3] ? +m[3] : now.getFullYear();
    if (y < 100) y += 2000;
    return dataValida(y, mo, d) ? iso(y, mo, d) : null;
  }
  m = t.match(/dia\s+(\d{1,2})/);
  if (m) {
    const d = +m[1];
    let mo = now.getMonth() + 1, y = now.getFullYear();
    if (d < now.getDate()) { mo += 1; if (mo > 12) { mo = 1; y += 1; } }
    // se o dia não existe no mês alvo (ex: dia 31 em mês de 30), tenta o próximo mês
    if (!dataValida(y, mo, d)) { mo += 1; if (mo > 12) { mo = 1; y += 1; } }
    return dataValida(y, mo, d) ? iso(y, mo, d) : null;
  }
  if (/hoje/.test(t)) return now.toISOString().slice(0, 10);
  if (/amanh/.test(t)) { const a = new Date(now.getTime() + 86400000); return a.toISOString().slice(0, 10); }
  return null;
}
function numero(texto: string): number | null {
  const t = texto.replace(/r\$\s*/i, "").replace(/\./g, "").replace(",", ".").match(/-?\d+(\.\d+)?/);
  if (!t) return null;
  const n = Number(t[0]);
  return isNaN(n) ? null : n;
}
function fmtData(iso: string): string {
  try { return new Date(iso + "T12:00:00").toLocaleDateString("pt-BR"); } catch { return iso; }
}

export interface WizResult { reply: string; done: boolean }

// ════════════════════════ LEAD ════════════════════════
function proxLead(d: any): string {
  if (!d.nome) return "nome";
  if (!d.telefone) return "telefone";
  if (!d.empreendimento_id && !d.empreendimento_nome) return "empreendimento";
  if (!d.origem) return "origem";
  if (!d.canal) return "canal";
  return "confirmar";
}
async function perguntaLead(user: Usuario, st: WizardState): Promise<string> {
  st.passo = proxLead(st.dados);
  await setWizard(user.id, st);
  const d = st.dados;
  switch (st.passo) {
    case "nome": return "👤 Vamos cadastrar o lead! Qual o *nome* dele?";
    case "telefone": return `📱 Qual o *telefone* de ${d.nome}? (com DDD)`;
    case "empreendimento": {
      const emp = st.emp || [];
      if (emp.length === 0) return "🏢 De qual *empreendimento* é o lead? (digite o nome)";
      const lista = emp.map((e, i) => `${i + 1}) ${e.nome}`).join("\n");
      return `🏢 De qual *empreendimento* é o lead?\n${lista}\n\n_(responda o número ou o nome)_`;
    }
    case "origem": return "📣 Qual a *origem* do lead? (ex: indicação, panfleto, faixa, Instagram, ligação...)";
    case "canal": return "💬 Como ele está *entrando em contato*? (WhatsApp, ligação, presencial...)";
    default:
      return `Confere os dados do lead:\n\n👤 *${d.nome}*\n📱 ${d.telefone}\n🏢 ${d.empreendimento_nome}\n📣 Origem: ${d.origem}\n💬 Contato: ${d.canal}\n\nResponda *sim* pra cadastrar ou *não* pra cancelar.`;
  }
}
export async function iniciarLead(user: Usuario, prefill: any): Promise<string> {
  const emp = await listarEmpreendimentos();
  const st: WizardState = {
    tipo: "lead", passo: "", emp,
    dados: {
      nome: (prefill?.lead_nome || "").trim() || null,
      telefone: (prefill?.lead_telefone || "").replace(/\D/g, "") || null,
      empreendimento_id: null, empreendimento_nome: null, origem: null, canal: null,
    },
  };
  return perguntaLead(user, st);
}
async function continuarLead(user: Usuario, st: WizardState, texto: string): Promise<WizResult> {
  const t = texto.trim(); const d = st.dados;
  switch (st.passo) {
    case "nome": d.nome = t.slice(0, 120); break;
    case "telefone": {
      const tel = t.replace(/\D/g, "");
      if (tel.length < 8) return { reply: "Telefone inválido. Manda com DDD (ex: 61999998888).", done: false };
      d.telefone = tel;
      // ⚠️ aviso de duplicado (não bloqueia — só alerta)
      try {
        const dup = await checarDuplicado(tel);
        if (dup.duplicado) {
          const prox = await perguntaLead(user, st);
          return { reply: `⚠️ *Atenção:* já existe um lead com esse telefone${dup.nome ? ` (*${dup.nome}*)` : ""} no CRM. Se for outro negócio, pode seguir; senão, *cancelar*.\n\n${prox}`, done: false };
        }
      } catch { /* indisponivel → segue normal */ }
      break;
    }
    case "empreendimento": {
      const emp = st.emp || [];
      if (emp.length === 0) { // CRM sem lista → aceita texto livre (não trava o cadastro)
        if (!t) return { reply: "Digite o nome do empreendimento 🙂", done: false };
        d.empreendimento_nome = t.slice(0, 200); break;
      }
      let sel: any = null; const n = parseInt(t, 10);
      if (!isNaN(n) && n >= 1 && n <= emp.length) sel = emp[n - 1];
      else sel = emp.find((e) => e.nome.toLowerCase().includes(t.toLowerCase()) || t.toLowerCase().includes(e.nome.toLowerCase()));
      if (!sel) return { reply: "Não identifiquei o empreendimento. Responda o *número* da lista ou o nome.", done: false };
      d.empreendimento_id = sel.id; d.empreendimento_nome = sel.nome; break;
    }
    case "origem": d.origem = t.slice(0, 100); break;
    case "canal": d.canal = t.slice(0, 200); break;
    case "confirmar": {
      if (SIM.test(t)) {
        const r = await criarLead({ nome: d.nome, telefone: d.telefone, owner_email: user.crm_email, empreendimento_id: d.empreendimento_id, empreendimento_nome: d.empreendimento_nome, captacao_origem: d.origem, notes: `Canal de contato: ${d.canal}` });
        await clearWizard(user.id);
        if (!r.ok) return { reply: `Não consegui cadastrar agora 😕 (${r.erro || "erro"}).`, done: true };
        return { reply: `✅ Lead *${d.nome}* cadastrado no CRM!\n🏢 ${d.empreendimento_nome} · 📣 ${d.origem}\n\nVeja em painel.natela.exemplo.com`, done: true };
      }
      await clearWizard(user.id);
      return { reply: "Ok, cancelei o cadastro 👍", done: true };
    }
  }
  return { reply: await perguntaLead(user, st), done: false };
}

// ════════════════════════ PAGAMENTO ════════════════════════
function proxPg(d: any): string {
  if (!d.lead_id) return "lead";
  if (!d.forma) return "forma";
  if (d.entrada_valor == null) return "entrada_valor";
  if (d.entrada_valor > 0 && d.entrada_agora == null) return "entrada_agora";
  if (d.num_parcelas == null) return "num_parcelas";
  // à vista (0 parcelas) pula valor_parcela e 1º vencimento
  if (d.num_parcelas > 0 && d.valor_parcela == null) return "valor_parcela";
  if (d.num_parcelas > 0 && !d.primeiro_venc) return "primeiro_venc";
  return "confirmar";
}
async function perguntaPg(user: Usuario, st: WizardState): Promise<string> {
  st.passo = proxPg(st.dados);
  await setWizard(user.id, st);
  const d = st.dados;
  switch (st.passo) {
    case "lead": return "💰 Registrar pagamento — de qual *cliente/lead*? (nome ou telefone)";
    case "forma": return `Qual a *forma de pagamento*? (pix, cartão ou boleto)`;
    case "entrada_valor": return "Teve *entrada*? Quanto foi? (responda o valor, ou *0* / *não* se não teve)";
    case "entrada_agora": return `A entrada de ${brl(d.entrada_valor)} foi *paga agora*? (sim/não)`;
    case "num_parcelas": return "Em *quantas parcelas* foi dividido o restante? (ou *à vista* / *0* se foi tudo de uma vez)";
    case "valor_parcela": return "Qual o *valor de cada parcela*?";
    case "primeiro_venc": return "Qual a data do *1º vencimento*? (ex: 15/07 ou dia 15)";
    default: {
      const aVista = !d.num_parcelas || d.num_parcelas === 0;
      const linhas = [
        `💰 *Pagamento de ${d.lead_nome}*`,
        `Forma: *${d.forma}*`,
        d.entrada_valor > 0 ? `${aVista ? "Valor" : "Entrada"}: ${brl(d.entrada_valor)}${d.entrada_agora ? " (pago agora)" : " (a pagar)"}` : "Sem entrada",
        aVista ? "💵 À vista (sem parcelas)" : `Parcelas: *${d.num_parcelas}x de ${brl(d.valor_parcela)}*`,
      ];
      if (!aVista) linhas.push(`1º vencimento: *${fmtData(d.primeiro_venc)}* (intervalo 30 dias)`);
      return linhas.join("\n") + "\n\nConfirma? *sim* pra lançar / *não* pra cancelar.";
    }
  }
}
export async function iniciarPagamento(user: Usuario, prefill: any): Promise<string> {
  const st: WizardState = {
    tipo: "pagamento", passo: "",
    dados: {
      lead_id: null, lead_nome: null,
      forma: normalizarMetodo(prefill?.metodo_pagamento) || null,
      entrada_valor: null, entrada_agora: null,
      num_parcelas: null, valor_parcela: null, primeiro_venc: null,
    },
  };
  // tenta resolver o lead já citado
  const alvo = (prefill?.lead_alvo || "").trim();
  if (alvo && user.crm_email) {
    const b = await buscarLead(user.crm_email, alvo);
    if (b.ok && b.lead) { st.dados.lead_id = b.lead.id; st.dados.lead_nome = b.lead.name; }
  }
  return perguntaPg(user, st);
}
async function continuarPagamento(user: Usuario, st: WizardState, texto: string): Promise<WizResult> {
  const t = texto.trim(); const d = st.dados;
  switch (st.passo) {
    case "lead": {
      if (!user.crm_email) { await clearWizard(user.id); return { reply: "CRM não ativado pra você.", done: true }; }
      const b = await buscarLead(user.crm_email, t);
      if (!b.ok || !b.lead) return { reply: `Não achei o lead "${t}". Tenta o nome completo ou o telefone.`, done: false };
      d.lead_id = b.lead.id; d.lead_nome = b.lead.name; break;
    }
    case "forma": { const f = normalizarMetodo(t); if (!f) return { reply: "Não entendi. Responda *pix*, *cartão* ou *boleto*.", done: false }; d.forma = f; break; }
    case "entrada_valor": {
      if (/^(n[ãa]o|sem|nenhuma)/i.test(t)) { d.entrada_valor = 0; d.entrada_agora = false; break; }
      const v = numero(t); if (v == null || v < 0) return { reply: "Quanto foi a entrada? Manda o valor (ou *0* se não teve).", done: false };
      d.entrada_valor = v; break;
    }
    case "entrada_agora": d.entrada_agora = SIM.test(t); break;
    case "num_parcelas": {
      if (/(à\s*vista|a\s*vista|avista|sem\s*parcela)/i.test(t)) { d.num_parcelas = 0; break; }
      const n = numero(t); if (n == null || n < 0 || n > 360) return { reply: "Quantas parcelas? (um número, ex: 12, ou *à vista*)", done: false };
      d.num_parcelas = Math.round(n); break;
    }
    case "valor_parcela": { const v = numero(t); if (v == null || v <= 0) return { reply: "Qual o valor de cada parcela? (ex: 500)", done: false }; d.valor_parcela = v; break; }
    case "primeiro_venc": { const dt = dataBR(t); if (!dt) return { reply: "Não entendi a data. Use *15/07* ou *dia 15*.", done: false }; d.primeiro_venc = dt; break; }
    case "confirmar": {
      if (!SIM.test(t)) { await clearWizard(user.id); return { reply: "Ok, cancelei o lançamento 👍", done: true }; }
      // validação: precisa ter ALGO pra lançar (entrada/valor ou parcelas)
      if ((d.entrada_valor || 0) <= 0 && (d.num_parcelas || 0) <= 0) {
        await clearWizard(user.id);
        return { reply: "Sem valor de entrada e sem parcelas — não havia nada pra lançar. Cancelado 👍", done: true };
      }
      const hoje = new Date().toISOString().slice(0, 10);
      // 1) registra a entrada/valor à vista como pagamento recebido, se foi pago agora
      let pagamentoRegistrado = false;
      if (d.entrada_valor > 0 && d.entrada_agora) {
        const pr = await registrarPagamentoDireto(d.lead_id, d.entrada_valor, d.forma, hoje).catch(() => ({ ok: false }));
        pagamentoRegistrado = Boolean((pr as any)?.ok);
      }
      // 2) à vista (0 parcelas): encerra sem cronograma
      if (!d.num_parcelas || d.num_parcelas === 0) {
        await clearWizard(user.id);
        const obs = d.entrada_agora && !pagamentoRegistrado ? "\n⚠️ (não consegui registrar o pagamento no CRM — confira no painel)" : "";
        return { reply: `✅ *Pagamento à vista de ${d.lead_nome}*!\n💰 ${brl(d.entrada_valor)} (${d.forma})${d.entrada_agora ? " — recebido" : " — a receber"}${obs}`, done: true };
      }
      // 3) gera o cronograma de parcelas
      const g = await gerarParcelas(d.lead_id, {
        entrada_valor: d.entrada_valor > 0 ? d.entrada_valor : undefined,
        entrada_vencimento: d.entrada_valor > 0 ? (d.entrada_agora ? hoje : d.primeiro_venc) : undefined,
        num_parcelas: d.num_parcelas, valor_parcela: d.valor_parcela,
        primeiro_vencimento: d.primeiro_venc, intervalo_dias: 30,
      });
      await clearWizard(user.id);
      if (!g.ok) return { reply: `Não consegui gerar as parcelas agora 😕 (${g.erro || "erro"}).`, done: true };
      // monta as datas dos próximos vencimentos (cálculo local p/ exibir)
      const base = new Date(d.primeiro_venc + "T12:00:00");
      const datas: string[] = [];
      for (let i = 0; i < Math.min(d.num_parcelas, 6); i++) {
        const dt = new Date(base.getTime()); dt.setDate(dt.getDate() + i * 30);
        datas.push(`  ${i + 1}ª — ${dt.toLocaleDateString("pt-BR")} · ${brl(d.valor_parcela)}`);
      }
      const maisTxt = d.num_parcelas > 6 ? `\n  …e mais ${d.num_parcelas - 6} parcela(s).` : "";
      const entradaTxt = d.entrada_valor > 0 ? `Entrada: ${brl(d.entrada_valor)}${d.entrada_agora ? " ✅ recebida" : " (a pagar)"}\n` : "";
      return { reply: `✅ *Pagamento de ${d.lead_nome}* lançado!\n${entradaTxt}Parcelas: ${d.num_parcelas}x de ${brl(d.valor_parcela)} (${d.forma})\n\n🗓️ *Próximos vencimentos:*\n${datas.join("\n")}${maisTxt}`, done: true };
    }
  }
  return { reply: await perguntaPg(user, st), done: false };
}

// ── Dispatcher ────────────────────────────────────────────────
export async function continuarWizard(user: Usuario, st: WizardState, texto: string): Promise<WizResult> {
  if (CANCELAR.test(texto)) { await clearWizard(user.id); return { reply: "Beleza, cancelei 👍", done: true }; }
  if (st.tipo === "lead") return continuarLead(user, st, texto);
  if (st.tipo === "pagamento") return continuarPagamento(user, st, texto);
  if (st.tipo === "contrato") return continuarContrato(user, st, texto);
  await clearWizard(user.id);
  return { reply: "Ok 🙂", done: true };
}

// ════════════════════════ CONTRATO ════════════════════════
function valorBR(s: string): string {
  const n = numero(s);
  if (n == null) return s.trim();
  return n.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export async function iniciarContrato(user: Usuario): Promise<string> {
  const st: WizardState = { tipo: "contrato", passo: "rg", dados: {} };
  await setWizard(user.id, st);
  // Lembrete: sem modelo próprio no CRM → avisa que vai usar o padrão
  let aviso = "";
  if (user.crm_email) {
    const tpl = await baixarTemplateContrato(user.crm_email).catch(() => null);
    if (!tpl) aviso = "\n\n⚠️ Você ainda não enviou o *seu* contrato no CRM (painel → Configurações → *Contrato de Intermediação*). Por enquanto vou usar o modelo padrão.";
  }
  return "📄 *Vamos gerar o contrato de intermediação!*\n\nMe envie a *foto do RG ou CNH* do cliente." + aviso + "\n\n_(a qualquer momento responda *cancelar* para sair)_";
}

function perguntaNegocio(d: DadosCliente): string {
  const faltaEnd = !d.endereco ? "\nEndereço: \nCidade-UF: \nCEP: " : "";
  return "🏗️ Agora os dados do *negócio*. Copie e preencha (deixe em branco o que não tiver):\n\n" +
    "Quadra: \nLote: \nValor da intermediação (R$): \nProfissão: \nE-mail: \nTelefone: " + faltaEnd;
}

function parseNegocio(t: string, d: DadosCliente): void {
  const get = (re: RegExp): string | null => { const m = t.match(re); return m && m[1] ? m[1].trim() : null; };
  d.quadra = get(/quadra\s*:?\s*([^\n]+)/i) || d.quadra;
  d.lote = get(/lote\s*:?\s*([^\n]+)/i) || d.lote;
  const v = get(/valor[^\n:]*:?\s*r?\$?\s*([\d.,]+)/i); if (v) d.valor = valorBR(v);
  d.profissao = get(/profiss\w*\s*:?\s*([^\n]+)/i) || d.profissao;
  d.email = get(/e-?mail\s*:?\s*([^\s\n]+@[^\s\n]+)/i) || d.email;
  d.telefone = get(/(?:telefone|tel|celular|fone|whats\w*)\s*:?\s*([\d\s()+-]{8,})/i) || d.telefone;
  d.endereco = get(/endere[çc]o\s*:?\s*([^\n]+)/i) || d.endereco;
  d.cidade_uf = get(/cidade[^\n:]*:?\s*([^\n]+)/i) || d.cidade_uf;
  d.cep = get(/cep\s*:?\s*([\d.\-]{8,})/i) || d.cep;
}

function resumoContrato(d: DadosCliente): string {
  const L = (k: string, v?: string | null) => (v ? `${k}: *${v}*` : null);
  return [
    L("👤 Nome", d.nome), L("🆔 CPF", d.cpf), L("🪪 RG", d.rg ? (d.orgao ? `${d.rg} ${d.orgao}` : d.rg) : null),
    L("💍 Estado civil", d.estado_civil), L("🏠 Endereço", d.endereco), L("🌆 Cidade", d.cidade_uf),
    L("📮 CEP", d.cep), L("📧 E-mail", d.email), L("💼 Profissão", d.profissao), L("📱 Tel", d.telefone),
    L("🧱 Quadra", d.quadra), L("📐 Lote", d.lote), L("💰 Valor", d.valor ? "R$ " + d.valor : null),
    L("👫 Cônjuge", d.conj_nome ? `${d.conj_nome} (CPF ${d.conj_cpf || "?"})` : null),
    L("💳 Pagamento", d.pagamento === "avista" ? "à vista" : d.parcelas?.length ? `${d.parcelas.length}x de R$ ${d.parcelas[0].valor} (1ª: ${d.parcelas[0].venc})` : null),
    L("🤝 Corretor (3,0%)", d.valor_corretor ? "R$ " + d.valor_corretor : null),
    L("👔 Gerente (0,3%)", d.valor_gerente ? "R$ " + d.valor_gerente : null),
  ].filter(Boolean).join("\n");
}

/** Recebe uma FOTO durante o wizard de contrato (RG ou comprovante). Chamado pelo server. */
export async function receberFotoContrato(user: Usuario, phone: string, st: WizardState, imageBase64?: string, mime?: string): Promise<void> {
  if (!imageBase64) { await responder(user, phone, "Não consegui baixar a imagem. Pode reenviar? 🙏"); return; }
  const d: DadosCliente = st.dados;
  const merge = (ex: any) => Object.assign(d, Object.fromEntries(Object.entries(ex).filter(([, v]) => v != null && v !== "")));
  if (st.passo === "rg") {
    merge(await extrairDocumento(imageBase64, mime));
    if (!d.nome && !d.cpf) { await responder(user, phone, "📷 Não consegui ler o documento. Pode mandar uma foto mais nítida? 🙏"); return; }
    st.passo = "comprovante"; await setWizard(user.id, st);
    await responder(user, phone, `✅ Li o documento:\n👤 ${d.nome || "?"}\n🆔 CPF ${d.cpf || "?"}${d.estado_civil ? `\n💍 ${d.estado_civil}` : ""}\n\nAgora me manda a *foto de um comprovante de endereço* (conta de luz/água).\nOu digite *pular*.`);
    return;
  }
  if (st.passo === "comprovante") {
    merge(await extrairEndereco(imageBase64, mime));
    st.passo = "negocio"; await setWizard(user.id, st);
    await responder(user, phone, perguntaNegocio(d));
    return;
  }
  if (st.passo === "conjuge_rg") {
    const ex = await extrairDocumento(imageBase64, mime);
    if (!ex.nome && !ex.cpf) { await responder(user, phone, "📷 Não consegui ler o RG do cônjuge. Manda uma foto mais nítida 🙏"); return; }
    d.conj_nome = ex.nome || null; d.conj_cpf = ex.cpf || null; d.conj_rg = ex.rg || null;
    d.conj_orgao = ex.orgao || null; d.conj_estado_civil = ex.estado_civil || null;
    st.passo = "pagamento"; await setWizard(user.id, st);
    await responder(user, phone, `✅ Cônjuge: *${d.conj_nome || "?"}* (CPF ${d.conj_cpf || "?"}).\n\n💳 Como será pago? Responda *à vista* ou ex: *3x de 500 a partir de 15/07*`);
    return;
  }
  await responder(user, phone, "Recebi a imagem 🙂 Mas agora preciso da sua resposta por texto.");
}

async function continuarContrato(user: Usuario, st: WizardState, texto: string): Promise<WizResult> {
  const d: DadosCliente = st.dados;
  const t = texto.trim();
  if (st.passo === "rg") return { reply: "📄 Preciso da *foto do RG/CNH* do cliente. Me envia a imagem 🙂 (ou *cancelar*)", done: false };
  if (st.passo === "comprovante") {
    if (/^(pular|pula|n[ãa]o|sem|depois)\b/i.test(t)) { st.passo = "negocio"; await setWizard(user.id, st); return { reply: perguntaNegocio(d), done: false }; }
    return { reply: "Me manda a *foto do comprovante de endereço*, ou digite *pular* 🙂", done: false };
  }
  if (st.passo === "negocio") {
    parseNegocio(t, d);
    st.passo = "conjuge_q"; await setWizard(user.id, st);
    return { reply: "👫 Tem *2º comprador/cônjuge*? Responda *sim* (e me manda a foto do RG dele) ou *não*.", done: false };
  }
  if (st.passo === "conjuge_q") {
    if (SIM.test(t)) { st.passo = "conjuge_rg"; await setWizard(user.id, st); return { reply: "📷 Me manda a *foto do RG/CNH do cônjuge*.", done: false }; }
    st.passo = "pagamento"; await setWizard(user.id, st);
    return { reply: "💳 Como será pago? Responda *à vista* ou ex: *3x de 500 a partir de 15/07*", done: false };
  }
  if (st.passo === "pagamento") {
    // Cálculo conforme o contrato: total informado = 3,3% → corretor 3,0% + gerente 0,3%.
    const fmt = (v: number) => v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const total = numero(String(d.valor || "")) || 0;
    if (total > 0) {
      d.valor_corretor = fmt(total * (3.0 / 3.3));
      d.valor_gerente = fmt(total * (0.3 / 3.3));
    }
    if (/vista/i.test(t)) { d.pagamento = "avista"; d.parcelas = null; d.parcelas_corretor = null; }
    else {
      const m = t.match(/(\d{1,2})\s*x(?:\s*(?:de\s*)?r?\$?\s*([\d.,]+))?/i);
      if (!m) return { reply: "Não entendi 🤔 Responda *à vista* ou ex: *3x a partir de 15/07* (eu calculo o valor de cada parcela) ou *3x de 500*", done: false };
      const n = Math.min(Math.max(Number(m[1]), 1), 3);
      const venc1 = dataBR(t);
      const base = venc1 ? new Date(venc1 + "T12:00:00") : new Date(Date.now() + 30 * 86400000);
      const datas = Array.from({ length: n }, (_, i) => { const dt = new Date(base.getTime()); dt.setMonth(dt.getMonth() + i); return dt.toLocaleDateString("pt-BR"); });
      // divide um valor em n parcelas (a última absorve o resto dos centavos)
      const dividir = (v: number) => { const p = Math.floor((v / n) * 100) / 100; const ult = Math.round((v - p * (n - 1)) * 100) / 100; return Array.from({ length: n }, (_, i) => (i === n - 1 ? ult : p)); };
      const vTotais = m[2] ? Array.from({ length: n }, () => numero(m[2]) || 0) : dividir(total);
      const vCorr = dividir(total * (3.0 / 3.3));
      d.pagamento = "parcelado";
      d.parcelas = vTotais.map((v, i) => ({ valor: fmt(v), venc: datas[i] }));
      d.parcelas_corretor = vCorr.map((v, i) => ({ valor: fmt(v), venc: datas[i] }));
    }
    st.passo = "confirmar"; await setWizard(user.id, st);
    return { reply: `Confere os dados do contrato:\n\n${resumoContrato(d)}\n\nResponda *sim* pra gerar, ou *não* pra cancelar.`, done: false };
  }
  if (st.passo === "confirmar") {
    if (!SIM.test(t)) { parseNegocio(t, d); await setWizard(user.id, st); return { reply: `Atualizei. Confere:\n\n${resumoContrato(d)}\n\nResponda *sim* pra gerar, ou *cancelar*.`, done: false }; }
    try {
      const tpl = templateDoCorretor(user.crm_email);
      // usa o modelo PRÓPRIO do corretor se ele subiu um no CRM (Configurações → Contrato)
      const proprio = user.crm_email ? await baixarTemplateContrato(user.crm_email) : null;
      const { base64, filename } = await preencherContrato(tpl, d, proprio || undefined);
      await sendDocument(user.phone, base64, filename, `📄 Contrato de ${d.nome || "cliente"} preenchido.`, "application/pdf");
      await clearWizard(user.id);
      return { reply: "✅ Pronto! Te enviei o *contrato preenchido* aqui em cima. Se precisar ajustar algo, é só me chamar 🙂", done: true };
    } catch (e) {
      await clearWizard(user.id);
      return { reply: "😕 Tive um problema ao gerar o PDF. Tenta de novo daqui a pouco.", done: true };
    }
  }
  await clearWizard(user.id);
  return { reply: "Ok 🙂", done: true };
}
