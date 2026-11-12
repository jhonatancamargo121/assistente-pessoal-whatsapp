import { pool } from "../db";
import { enc, dec } from "../crypto";
import type { Usuario } from "./allowlist";
import type { IntentResult } from "../ai/intent";
import type { ChatMsg } from "../ai/groq";
import { deepseekChat } from "../ai/deepseek";
import { config } from "../config";
import { criarLead, listarLeads, buscarLead, atualizarStatusLead, anotarLead, normalizarStatus, statusPt,
  listarPagamentos, criarAgendamento, listarAgendamentos,
  baixarRelatorioExcel, XLSX_MIME,
  resumoVendas, metaProgresso, rankingPosicao } from "./crm";
import { sendDocument } from "../evolution/client";
import { clima, cotacao } from "./skills";
import { criarHabito, registrarHabito, listarHabitos } from "./habitos";

export interface HandlerResult {
  reply: string;
  provider: "template" | "deepseek" | "groq";
}

function brl(v: number): string {
  return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

/** Usuário com CRM ativo (corretor) → recebe o menu de funções do CRM. */
function ehCrmUser(user: Usuario): boolean {
  return Boolean(user.crm_email) || Boolean(user.crm_ativo);
}

/** Guia para CLIENTE COMUM (assistente pessoal). */
function ajudaComum(): string {
  return (
    `🤖 *Seu Assistente Pessoal — guia completo*\n` +
    `Fale comigo naturalmente, por *texto* ou *áudio*. Veja tudo que eu faço:\n\n` +
    `📋 *TAREFAS*\n` +
    `• "dentista terça 15h" — anoto com lembrete\n` +
    `• "o que tenho hoje?" — lista suas tarefas\n` +
    `• "concluí o dentista" — marca como feita\n\n` +
    `🔁 *ROTINAS*\n` +
    `• "academia seg/qua/sex 7h" — repito toda semana e te lembro\n\n` +
    `📅 *PLANEJAMENTO*\n` +
    `• "monta meu plano da semana" — organizo seus dias e horários livres\n` +
    `• "como está minha agenda?" — consulto seus compromissos\n\n` +
    `💸 *FINANÇAS*\n` +
    `• "gastei 50 no mercado" — registro o gasto\n` +
    `• "recebi 2000 de salário" — registro a entrada\n` +
    `• "qual meu saldo?" — entradas, saídas e saldo do mês\n` +
    `• "extrato" — seus últimos lançamentos\n\n` +
    `📷 *COMPROVANTE POR FOTO OU PDF*\n` +
    `• Manda a *foto* ou o *PDF* de um comprovante/nota — eu leio o valor e pergunto a categoria\n\n` +
    `📊 *CONTROLE PERSONALIZADO*\n` +
    `• Envie uma *planilha Excel* com suas categorias e metas — eu configuro seu controle\n` +
    `• Aviso quando você se aproximar ou estourar a *meta* de uma categoria\n\n` +
    `📅 *RELATÓRIOS*\n` +
    `• "resumo da semana" — gastos, entradas e tarefas dos últimos 7 dias\n\n` +
    `🎙️ *VOZ*\n` +
    `• "responde em áudio" ou "prefiro texto" — você escolhe como eu respondo\n\n` +
    `Pode começar agora! Ex: *"gastei 30 no almoço"* 🙂`
  );
}

/** Guia para CORRETOR (usuário do CRM) — funções de vendas + contrato. */
function ajudaCorretor(): string {
  return (
    `🏢 *Seu Assistente de Vendas — guia do CRM*\n` +
    `Fale comigo por *texto* ou *áudio*. Tudo que você cadastrar cai no seu CRM. Veja:\n\n` +
    `👥 *LEADS*\n` +
    `• "cadastra um lead" — eu te guio passo a passo\n` +
    `• "meus leads" / "leads em negociação" — lista seus clientes\n` +
    `• "como está o lead do João?" — status e detalhes\n` +
    `• "muda o João pra negociando" — atualiza a etapa\n` +
    `• "anota no lead da Maria que ela pediu desconto" — registra a interação\n\n` +
    `💰 *PAGAMENTOS*\n` +
    `• "recebi 5 mil no pix do João" — lanço o pagamento\n` +
    `• "quanto a Maria já pagou?" — histórico de pagamentos\n\n` +
    `📅 *AGENDA / VISITAS*\n` +
    `• "agenda visita com o João sábado 10h" — marco no CRM\n` +
    `• "minhas visitas da semana" — sua agenda\n\n` +
    `📄 *CONTRATO AUTOMÁTICO*\n` +
    `• "preenche um contrato" — manda a *foto do RG* do cliente que eu gero o *PDF preenchido* pra imprimir/assinar\n\n` +
    `📊 *RELATÓRIOS*\n` +
    `• "relatório financeiro" — vendas e comissão do período\n` +
    `• "exporta meus leads" — planilha Excel dos seus leads\n\n` +
    `🎙️ *VOZ*\n` +
    `• "responde em áudio" ou "prefiro texto"\n\n` +
    `💡 Você também usa as funções pessoais (tarefas, finanças, lembretes). Manda *ajuda pessoal* pra ver.\n` +
    `Bora vender! Ex: *"cadastra um lead"* 🚀`
  );
}

function fmtData(iso: string, tz: string): string {
  try {
    return new Date(iso).toLocaleString("pt-BR", {
      timeZone: tz,
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

const DIAS = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

export async function handle(intent: IntentResult, user: Usuario, textoOriginal: string, historico: ChatMsg[] = []): Promise<HandlerResult> {
  switch (intent.intent) {
    // ── Tarefas ────────────────────────────────────────────
    case "criar_tarefa": {
      const titulo = (intent.titulo || "").trim();
      if (!titulo) return { reply: "Qual é a tarefa? Me diz o que quer anotar 🙂", provider: "template" };
      // Validação: data inválida → ignora (não inventa)
      let due = intent.due_at ? new Date(intent.due_at) : null;
      if (due && isNaN(due.getTime())) due = null;
      let lembrete = intent.lembrete_at ? new Date(intent.lembrete_at) : due;
      if (lembrete && isNaN(lembrete.getTime())) lembrete = due;
      await pool.query(
        `INSERT INTO tarefas (user_id, titulo, due_at, lembrete_at) VALUES ($1,$2,$3,$4)`,
        [user.id, titulo, due, lembrete]
      );
      const quando = due ? ` para ${fmtData(due.toISOString(), user.timezone)}` : "";
      return { reply: `✅ Anotado: *${titulo}*${quando}.`, provider: "template" };
    }

    case "criar_rotina": {
      const titulo = (intent.titulo || "").trim();
      // Validação: só dias inteiros válidos 0..6 (mata o lixo tipo "12345")
      const dias = (Array.isArray(intent.dias_semana) ? intent.dias_semana : [])
        .map((d) => Number(d))
        .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
      const hora = /^\d{1,2}:\d{2}$/.test(String(intent.hora || "")) ? intent.hora : null;
      const horaFim = /^\d{1,2}:\d{2}$/.test(String(intent.hora_fim || "")) ? intent.hora_fim : null;
      if (!titulo || dias.length === 0 || !hora)
        return { reply: "Pra criar uma rotina preciso do quê, em quais dias e que horas. Ex: _academia seg/qua/sex 7h_.", provider: "template" };
      // Com intervalo (ex: trabalho 8 às 17) = bloco de agenda → não vira lembrete recorrente
      const lembrar = !horaFim;
      await pool.query(
        `INSERT INTO rotinas (user_id, titulo, dias_semana, hora, hora_fim, lembrar) VALUES ($1,$2,$3,$4,$5,$6)`,
        [user.id, titulo, dias, hora, horaFim, lembrar]
      );
      const diasTxt = dias.map((d) => DIAS[d] ?? d).join("/");
      if (horaFim)
        return { reply: `🗓️ Anotei na sua agenda: *${titulo}* — ${diasTxt} das ${hora} às ${horaFim}.`, provider: "template" };
      return { reply: `🔁 Rotina criada: *${titulo}* — ${diasTxt} às ${hora}. Vou te lembrar 🙂`, provider: "template" };
    }

    case "listar_hoje": {
      const { rows } = await pool.query(
        `SELECT titulo, due_at FROM tarefas
          WHERE user_id=$1 AND status='pendente'
            AND (due_at IS NULL OR due_at::date <= current_date + 1)
          ORDER BY due_at NULLS LAST LIMIT 30`,
        [user.id]
      );
      if (rows.length === 0) return { reply: "Você não tem tarefas pendentes pra hoje 🎉", provider: "template" };
      const linhas = rows.map((r: any) => {
        const h = r.due_at ? ` — ${fmtData(r.due_at, user.timezone)}` : "";
        return `• ${r.titulo}${h}`;
      });
      return { reply: `📋 *Suas tarefas:*\n${linhas.join("\n")}`, provider: "template" };
    }

    case "concluir_tarefa": {
      const alvo = (intent.alvo || intent.titulo || "").trim();
      if (!alvo) return { reply: "Qual tarefa você concluiu?", provider: "template" };
      const { rows } = await pool.query(
        `UPDATE tarefas SET status='concluida'
          WHERE id = (
            SELECT id FROM tarefas
             WHERE user_id=$1 AND status='pendente' AND titulo ILIKE '%'||$2||'%'
             ORDER BY due_at NULLS LAST LIMIT 1
          ) RETURNING titulo`,
        [user.id, alvo]
      );
      if (!rows[0]) return { reply: `Não achei uma tarefa pendente com "${alvo}".`, provider: "template" };
      return { reply: `✔️ Concluída: *${rows[0].titulo}*. Boa!`, provider: "template" };
    }

    // ── Financeiro ─────────────────────────────────────────
    case "registrar_gasto":
    case "registrar_entrada": {
      const tipo = intent.intent === "registrar_gasto" ? "saida" : "entrada";
      const valor = Number(intent.valor);
      // Validação: valor positivo, finito e numa faixa sã
      if (!valor || !isFinite(valor) || valor <= 0 || valor > 10_000_000)
        return { reply: "Qual o valor? Ex: _gastei 50 no mercado_.", provider: "template" };
      await pool.query(
        `INSERT INTO lancamentos (user_id, tipo, valor, categoria, descricao) VALUES ($1,$2,$3,$4,$5)`,
        [user.id, tipo, valor, intent.categoria || null, enc(intent.descricao || null)]
      );
      const emoji = tipo === "saida" ? "💸" : "💰";
      const cat = intent.categoria ? ` (${intent.categoria})` : "";
      let alerta = "";
      // 🎯 Alerta de orçamento: se for saída numa categoria com meta, checa o acumulado do mês
      if (tipo === "saida" && intent.categoria) {
        alerta = await checarMeta(user.id, intent.categoria);
      }
      return { reply: `${emoji} Registrado: ${brl(valor)}${cat}.${alerta}`, provider: "template" };
    }

    case "consultar_saldo": {
      const { rows } = await pool.query(
        `SELECT
           COALESCE(SUM(valor) FILTER (WHERE tipo='entrada'),0) AS entradas,
           COALESCE(SUM(valor) FILTER (WHERE tipo='saida'),0)   AS saidas
         FROM lancamentos
         WHERE user_id=$1 AND date_trunc('month',ocorrido_em)=date_trunc('month',current_date)`,
        [user.id]
      );
      const e = Number(rows[0].entradas), s = Number(rows[0].saidas);
      return {
        reply: `📊 *Este mês:*\nEntradas: ${brl(e)}\nSaídas: ${brl(s)}\nSaldo: *${brl(e - s)}*`,
        provider: "template",
      };
    }

    case "extrato": {
      const { rows } = await pool.query(
        `SELECT tipo, valor, categoria, descricao, ocorrido_em FROM lancamentos
          WHERE user_id=$1 ORDER BY ocorrido_em DESC, created_at DESC LIMIT 15`,
        [user.id]
      );
      if (rows.length === 0) return { reply: "Sem lançamentos ainda.", provider: "template" };
      const linhas = rows.map((r: any) => {
        const sinal = r.tipo === "saida" ? "−" : "+";
        const desc = dec(r.descricao);
        const cat = r.categoria ? ` ${r.categoria}` : desc ? ` ${desc}` : "";
        return `${sinal} ${brl(Number(r.valor))}${cat}`;
      });
      return { reply: `🧾 *Últimos lançamentos:*\n${linhas.join("\n")}`, provider: "template" };
    }

    case "relatorio_semanal": {
      const { rows } = await pool.query(
        `SELECT
           COALESCE(SUM(valor) FILTER (WHERE tipo='entrada'),0) AS entradas,
           COALESCE(SUM(valor) FILTER (WHERE tipo='saida'),0)   AS saidas,
           COUNT(*) FILTER (WHERE tipo='saida') AS qtd_saidas
         FROM lancamentos
         WHERE user_id=$1 AND ocorrido_em >= current_date - 7`,
        [user.id]
      );
      const { rows: tarefas } = await pool.query(
        `SELECT COUNT(*) FILTER (WHERE status='concluida') AS feitas,
                COUNT(*) FILTER (WHERE status='pendente')  AS pendentes
         FROM tarefas WHERE user_id=$1 AND created_at >= current_date - 7`,
        [user.id]
      );
      const e = Number(rows[0].entradas), s = Number(rows[0].saidas);
      return {
        reply:
          `📅 *Resumo dos últimos 7 dias*\n\n` +
          `💰 Entradas: ${brl(e)}\n💸 Saídas: ${brl(s)} (${rows[0].qtd_saidas} lançamentos)\n📈 Saldo: *${brl(e - s)}*\n\n` +
          `✅ Tarefas feitas: ${tarefas[0].feitas}\n📋 Pendentes: ${tarefas[0].pendentes}`,
        provider: "template",
      };
    }

    case "ajuda": {
      // Corretor (CRM) vê o menu de vendas; cliente comum vê o pessoal.
      // "ajuda pessoal" força o menu pessoal mesmo para corretor.
      const querPessoal = /pessoal/.test(String(textoOriginal || "").toLowerCase());
      return { reply: ehCrmUser(user) && !querPessoal ? ajudaCorretor() : ajudaComum(), provider: "template" };
    }

    // ── CRM: cadastrar lead ────────────────────────────────
    case "criar_lead": {
      // CRM habilitado = ter um email de conta do CRM vinculado (ou o flag legado).
      const crmHabilitado = Boolean(user.crm_email) || user.crm_ativo;
      if (!crmHabilitado) {
        return { reply: "O CRM não está ativado para você. Fale com o administrador 🙂", provider: "template" };
      }
      const nome = (intent.lead_nome || "").trim();
      const tel = (intent.lead_telefone || "").replace(/\D/g, "");
      if (!nome || tel.length < 8) {
        return { reply: 'Pra cadastrar o lead preciso de nome e telefone. Ex: _novo lead: Maria, 61 99999-9999, interessada no lote 5, à vista_.', provider: "template" };
      }
      const r = await criarLead({
        nome,
        telefone: tel,
        interesse: intent.lead_interesse,
        valor: intent.lead_valor,
        pagamento: intent.lead_pagamento,
        owner_email: user.crm_email, // vincula o lead à conta do cliente no CRM
      });
      if (!r.ok) {
        return { reply: `Não consegui cadastrar o lead agora 😕 (${r.erro || "erro"}). Tenta de novo em instantes.`, provider: "template" };
      }
      const det = [
        intent.lead_interesse ? `interesse: ${intent.lead_interesse}` : null,
        intent.lead_pagamento ? `pgto: ${intent.lead_pagamento}` : null,
      ].filter(Boolean).join(" · ");
      return {
        reply: `✅ Lead cadastrado no CRM: *${nome}* (${tel})${det ? "\n" + det : ""}\n\nVeja em: painel.natela.exemplo.com`,
        provider: "template",
      };
    }

    // ── CRM: gestão de leads (listar / consultar / status / anotar) ──
    case "listar_leads":
    case "consultar_lead":
    case "atualizar_lead_status":
    case "anotar_lead": {
      const ownerEmail = user.crm_email;
      if (!ownerEmail) return { reply: "O CRM não está ativado para você. Fale com o administrador 🙂", provider: "template" };

      // LISTAR
      if (intent.intent === "listar_leads") {
        const statusEn = normalizarStatus(intent.lead_status) || undefined;
        const r = await listarLeads(ownerEmail, { status: statusEn, limit: 15 });
        if (!r.ok) return { reply: "Não consegui consultar seus leads agora 😕 Tenta de novo em instantes.", provider: "template" };
        if (!r.leads || r.leads.length === 0) return { reply: statusEn ? `Você não tem leads em *${statusPt(statusEn)}* no momento.` : "Você ainda não tem leads cadastrados 🙂", provider: "template" };
        const linhas = r.leads.map((l) => `• *${l.name}* — ${statusPt(l.status)}${l.empreendimento ? ` · ${l.empreendimento}` : ""}`);
        const extra = (r.total || r.leads.length) > r.leads.length ? `\n…e mais ${(r.total as number) - r.leads.length}.` : "";
        const dica = `\n\n💡 Pra *agendar*: _"agenda o ${r.leads[0].name.split(" ")[0]} dia 15 às 14h"_\n📊 Status: _"muda o ${r.leads[0].name.split(" ")[0]} pra negociando"_`;
        return { reply: `📇 *Seus leads${statusEn ? " em " + statusPt(statusEn) : ""}* (${r.total}):\n${linhas.join("\n")}${extra}${dica}`, provider: "template" };
      }

      // os demais precisam identificar o lead alvo
      const alvo = (intent.lead_alvo || "").trim();
      if (!alvo) return { reply: "Sobre qual lead? Me diz o nome ou o telefone 🙂", provider: "template" };
      const busca = await buscarLead(ownerEmail, alvo);
      if (!busca.ok || !busca.lead) return { reply: `Não achei nenhum lead com "${alvo}" no seu CRM 🤔`, provider: "template" };
      const lead = busca.lead;
      const aviso = busca.varios && busca.varios.length > 1 ? `\n_(achei ${busca.varios.length}; usei o mais recente: ${lead.name})_` : "";

      // CONSULTAR
      if (intent.intent === "consultar_lead") {
        const val = lead.entry_value ? ` · entrada ${Number(lead.entry_value).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })}` : "";
        return { reply: `📇 *${lead.name}*\n📱 ${lead.phone}\n📊 Status: *${statusPt(lead.status)}*${lead.empreendimento ? `\n🏗️ ${lead.empreendimento}` : ""}${val}${aviso}`, provider: "template" };
      }

      // ATUALIZAR STATUS
      if (intent.intent === "atualizar_lead_status") {
        const statusEn = normalizarStatus(intent.lead_status);
        if (!statusEn) return { reply: "Pra qual etapa? (novo, contatado, em visita, negociando, fechado ou perdido)", provider: "template" };
        const up = await atualizarStatusLead(lead.id, statusEn);
        if (!up.ok) return { reply: `Não consegui atualizar o lead agora 😕 (${up.erro || "erro"}).`, provider: "template" };
        return { reply: `✅ Lead *${lead.name}* atualizado para *${statusPt(statusEn)}*.${aviso}`, provider: "template" };
      }

      // ANOTAR
      if (intent.intent === "anotar_lead") {
        const nota = (intent.lead_nota || "").trim();
        if (!nota) return { reply: "O que você quer anotar nesse lead? 🙂", provider: "template" };
        const an = await anotarLead(lead.id, nota);
        if (!an.ok) return { reply: `Não consegui salvar a anotação agora 😕 (${an.erro || "erro"}).`, provider: "template" };
        return { reply: `📝 Anotado no lead *${lead.name}*: "${nota.slice(0, 120)}".${aviso}`, provider: "template" };
      }

      return { reply: "Pode repetir? 🙂", provider: "template" };
    }

    // ── CRM: pagamentos ────────────────────────────────────
    case "registrar_pagamento":
      // Usuários com CRM vão pro WIZARD de pagamento (server.ts intercepta antes do handle).
      // Aqui só chega quem NÃO tem CRM → mensagem de gate.
      return { reply: "O CRM não está ativado para você. Fale com o administrador 🙂", provider: "template" };

    case "consultar_pagamentos": {
      if (!user.crm_email) return { reply: "O CRM não está ativado para você. Fale com o administrador 🙂", provider: "template" };
      const alvo = (intent.lead_alvo || "").trim();
      if (!alvo) return { reply: "Pagamentos de qual cliente? Me diz o nome do lead 🙂", provider: "template" };
      const r = await listarPagamentos(user.crm_email, { leadAlvo: alvo });
      if (!r.ok) return { reply: "Não consegui consultar os pagamentos agora 😕", provider: "template" };
      if (!r.pagamentos || r.pagamentos.length === 0) return { reply: `Nenhum pagamento registrado pra "${alvo}" ainda.`, provider: "template" };
      const linhas = r.pagamentos.slice(0, 12).map((p) => `• ${brl(p.amount)} (${p.payment_method}) — ${fmtData(p.payment_date, user.timezone).slice(0, 10)}`);
      return { reply: `💰 *Pagamentos de ${r.pagamentos[0].lead_name || alvo}* (total ${brl(r.total || 0)}):\n${linhas.join("\n")}`, provider: "template" };
    }

    case "relatorio_financeiro": {
      if (!user.crm_email) return { reply: "O CRM não está ativado para você. Fale com o administrador 🙂", provider: "template" };
      const { start, end } = periodoRange(intent.periodo);
      const r = await listarPagamentos(user.crm_email, { start, end });
      if (!r.ok) return { reply: "Não consegui gerar o relatório agora 😕", provider: "template" };
      const pgs = r.pagamentos || [];
      if (pgs.length === 0) return { reply: `Nenhum pagamento no período (${start} a ${end}).`, provider: "template" };
      const porMetodo: Record<string, number> = {};
      const porLead: Record<string, number> = {};
      for (const p of pgs) { porMetodo[p.payment_method] = (porMetodo[p.payment_method] || 0) + p.amount; if (p.lead_name) porLead[p.lead_name] = (porLead[p.lead_name] || 0) + p.amount; }
      const mLin = Object.entries(porMetodo).map(([k, v]) => `  ${k}: ${brl(v)}`).join("\n");
      const topLeads = Object.entries(porLead).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `  • ${k}: ${brl(v)}`).join("\n");
      return { reply: `📊 *Relatório financeiro* (${start} a ${end})\n💰 Total: *${brl(r.total || 0)}* em ${pgs.length} pagamento(s)\n\nPor forma:\n${mLin}\n\nTop clientes:\n${topLeads}`, provider: "template" };
    }

    // ── CRM: agenda (agendamentos com clientes) ────────────
    case "criar_agendamento": {
      if (!user.crm_email) return { reply: "O CRM não está ativado para você. Fale com o administrador 🙂", provider: "template" };
      let quando = intent.agend_data_iso ? new Date(intent.agend_data_iso) : null;
      if (quando && isNaN(quando.getTime())) quando = null;
      if (!quando) return { reply: "Pra quando é o agendamento? Me diz a data e a hora (ex: _visita com o João sábado às 10h_).", provider: "template" };
      const titulo = (intent.agend_titulo || "Visita").trim();
      const r = await criarAgendamento(user.crm_email, { title: titulo, scheduledAtIso: quando.toISOString(), leadAlvo: intent.lead_alvo || undefined, description: intent.descricao || undefined });
      if (!r.ok) return { reply: `Não consegui criar o agendamento agora 😕 (${r.erro || "erro"}).`, provider: "template" };
      const comQuem = r.lead ? ` com *${r.lead.name}*` : "";
      return { reply: `📅 Agendado: *${titulo}*${comQuem} em ${fmtData(quando.toISOString(), user.timezone)}.`, provider: "template" };
    }

    case "listar_agendamentos": {
      if (!user.crm_email) return { reply: "O CRM não está ativado para você. Fale com o administrador 🙂", provider: "template" };
      const ag = agendaRange(intent.periodo);
      const r = await listarAgendamentos(user.crm_email, { start: ag.start, end: ag.end });
      if (!r.ok) return { reply: "Não consegui consultar sua agenda no CRM agora 😕", provider: "template" };
      if (!r.itens || r.itens.length === 0) return { reply: "Você não tem agendamentos nesse período 🙂", provider: "template" };
      const linhas = r.itens.slice(0, 15).map((a) => {
        const conf = a.confirmation_status === "confirmed" ? " ✅" : a.confirmation_status === "reschedule_requested" ? " 🔄" : "";
        return `• ${fmtData(a.scheduled_at, user.timezone)} — *${a.title}*${a.lead_name ? ` (${a.lead_name})` : ""}${conf}`;
      });
      return { reply: `📅 *Seus agendamentos:*\n${linhas.join("\n")}`, provider: "template" };
    }

    // ── CRM: exportar relatório (Excel) e enviar como arquivo ──
    case "exportar_relatorio": {
      if (!user.crm_email) return { reply: "O CRM não está ativado para você. Fale com o administrador 🙂", provider: "template" };
      const rel = await baixarRelatorioExcel(user.crm_email);
      if (!rel.ok || !rel.base64) return { reply: `Não consegui gerar o relatório agora 😕 (${rel.erro || "erro"}).`, provider: "template" };
      const ok = await sendDocument(user.phone, rel.base64, rel.filename || "relatorio.xlsx", "📊 Seu relatório de leads (Excel)", XLSX_MIME);
      if (!ok) return { reply: "Gerei o relatório mas não consegui enviar o arquivo agora 😕 Tenta de novo?", provider: "template" };
      return { reply: "📊 Pronto! Te enviei o *relatório de leads* em Excel aqui na conversa 👆", provider: "template" };
    }

    // ── Consultar agenda / horários livres (raciocina sobre dados REAIS) ──
    case "consultar_agenda": {
      const DIAS_FULL = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
      const rot = await pool.query(
        `SELECT titulo, dias_semana, hora::text AS hora, hora_fim::text AS hora_fim FROM rotinas WHERE user_id=$1 AND ativa ORDER BY hora`,
        [user.id]
      );
      const tar = await pool.query(
        `SELECT titulo, due_at FROM tarefas WHERE user_id=$1 AND status='pendente' AND due_at IS NOT NULL AND due_at >= now() - interval '1 day' ORDER BY due_at LIMIT 30`,
        [user.id]
      );
      const rotTxt = rot.rows.length
        ? rot.rows.map((r: any) => `- ${r.titulo}: ${(r.dias_semana || []).map((d: number) => DIAS_FULL[d]).join(", ")}, ${r.hora}${r.hora_fim ? ` às ${r.hora_fim}` : ""}`).join("\n")
        : "(nenhum compromisso fixo cadastrado)";
      const tarTxt = tar.rows.length
        ? tar.rows.map((r: any) => `- ${r.titulo}: ${fmtData(r.due_at, user.timezone)}`).join("\n")
        : "(nenhuma tarefa com data)";
      const agora = new Date().toLocaleString("pt-BR", { timeZone: config.APP_TIMEZONE, weekday: "long", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
      const sys =
        `Você é um assistente pessoal organizando a agenda do usuário (PT-BR). Agora: ${agora} (${config.APP_TIMEZONE}).\n\n` +
        `AGENDA REAL do usuário (use SOMENTE estes dados — NUNCA invente, NUNCA diga que não tem acesso):\n\n` +
        `COMPROMISSOS FIXOS DA SEMANA:\n${rotTxt}\n\n` +
        `TAREFAS COM DATA:\n${tarTxt}\n\n` +
        `Responda à pergunta do usuário com base nessa agenda. Se ele pedir horários LIVRES e informar a janela dele (ex: trabalha 8h-17h), calcule os livres subtraindo os compromissos daquele(s) dia(s). Se faltar algum dado, peça só o que falta. Responda curto e claro, em PT-BR.`;
      try {
        const reply = await deepseekChat([
          { role: "system", content: sys },
          ...historico.slice(-6),
          { role: "user", content: textoOriginal || "como está minha agenda?" },
        ]);
        return { reply: reply || "Pode detalhar o que você quer saber da sua agenda? 🙂", provider: "deepseek" };
      } catch {
        return { reply: "Tive um problema pra consultar sua agenda agora. Tenta de novo? 🙏", provider: "deepseek" };
      }
    }

    // ── Planejar a semana (dados REAIS + cálculo de livres em código) ──
    case "planejar_semana": {
      const rot = await pool.query(
        `SELECT titulo, dias_semana, hora::text AS hora, hora_fim::text AS hora_fim, lembrar
           FROM rotinas WHERE user_id=$1 AND ativa ORDER BY hora`,
        [user.id]
      );
      const tar = await pool.query(
        `SELECT titulo, due_at FROM tarefas
           WHERE user_id=$1 AND status='pendente' AND due_at IS NOT NULL
             AND due_at >= now() - interval '1 hour' AND due_at < now() + interval '8 days'
           ORDER BY due_at`,
        [user.id]
      );
      const janelaIni = /^\d{1,2}:\d{2}$/.test(String(intent.janela_inicio || "")) ? intent.janela_inicio! : "08:00";
      const janelaFim = /^\d{1,2}:\d{2}$/.test(String(intent.janela_fim || "")) ? intent.janela_fim! : "18:00";
      const agenda = montarAgendaSemana(rot.rows, tar.rows, user.timezone, janelaIni, janelaFim);

      const agora = new Date().toLocaleString("pt-BR", { timeZone: user.timezone, weekday: "long", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
      const sys =
        `Você é um assistente pessoal montando um PLANO DE SEMANA realista (PT-BR). Agora: ${agora} (${user.timezone}).\n\n` +
        `Jornada disponível do usuário: ${janelaIni} às ${janelaFim}.\n` +
        `Abaixo está a agenda REAL dos próximos 7 dias, com os compromissos já marcados e os HORÁRIOS LIVRES JÁ CALCULADOS (não recalcule, use como vieram):\n\n${agenda}\n\n` +
        `Monte um plano enxuto por dia: confirme os compromissos fixos e sugira encaixar tarefas/hábitos/descanso nos horários livres listados. Seja específico com horários, mas NÃO invente compromissos que não estão na agenda. Responda no estilo WhatsApp, com emojis moderados, curto e organizado por dia. Se faltar algum dado (ex: a jornada), pergunte só o que falta.`;
      try {
        const reply = await deepseekChat([
          { role: "system", content: sys },
          ...historico.slice(-6),
          { role: "user", content: textoOriginal || "monta meu plano da semana" },
        ]);
        return { reply: reply || "Me diz o horário que você tem livre (ex: das 8h às 18h) que eu monto o plano 🙂", provider: "deepseek" };
      } catch {
        return { reply: "Tive um problema pra montar o plano agora. Tenta de novo? 🙏", provider: "deepseek" };
      }
    }

    // ── Skills (Pro+) ──────────────────────────────────────
    case "clima":
      return { reply: await clima(intent.cidade), provider: "template" };
    case "cotacao":
      return { reply: await cotacao(), provider: "template" };

    // ── Hábitos (Pro+) ─────────────────────────────────────
    case "criar_habito": {
      const nome = (intent.titulo || "").trim();
      if (!nome) return { reply: "Qual hábito você quer criar? Ex: _criar o hábito de beber água_ 💧", provider: "template" };
      await criarHabito(user.id, nome);
      return { reply: `✅ Hábito criado: *${nome}*.\nQuando você cumprir, me avisa (ex: "fiz ${nome}") que eu marco e conto sua sequência! 🔥`, provider: "template" };
    }
    case "registrar_habito": {
      const r = await registrarHabito(user.id, intent.alvo || intent.titulo);
      if (!r) return { reply: "Não achei esse hábito. Quer criar? Ex: _criar o hábito de beber água_ 🙂", provider: "template" };
      if (r.jaMarcado) return { reply: `Você já tinha marcado *${r.nome}* hoje 👍 Sequência atual: *${r.streak} dia(s)* 🔥`, provider: "template" };
      return { reply: `🔥 *${r.nome}* marcado! Sequência: *${r.streak} dia(s)*. Bora manter!`, provider: "template" };
    }
    case "listar_habitos": {
      const lista = await listarHabitos(user.id);
      if (lista.length === 0) return { reply: "Você ainda não tem hábitos. Crie um: _criar o hábito de ler 10 páginas_ 📚", provider: "template" };
      const linhas = lista.map((h) => `${h.hoje ? "✅" : "⬜"} *${h.nome}* — 🔥 ${h.streak} dia(s)`);
      return { reply: `🏃 *Seus hábitos:*\n${linhas.join("\n")}`, provider: "template" };
    }

    // ── Contas fixas ────────────────────────────────────────
    case "criar_conta_fixa": {
      const nome = String(intent.titulo || "").trim();
      const dia = Number(intent.dia_vencimento || 0);
      if (!nome || !dia || dia < 1 || dia > 31) return { reply: "Me diz o nome da conta e o dia: ex *\"luz vence todo dia 10, uns 180\"* 🙂", provider: "template" };
      await pool.query(`INSERT INTO contas_fixas (user_id, nome, valor, dia_vencimento) VALUES ($1,$2,$3,$4)`,
        [user.id, nome.slice(0, 60), intent.valor || null, dia]);
      const v = intent.valor ? ` (~${brl(Number(intent.valor))})` : "";
      return { reply: `🧾 Conta fixa anotada: *${nome}*${v}, vence todo dia *${dia}*.\nVou te avisar 2 dias antes do vencimento 😉`, provider: "template" };
    }
    case "listar_contas": {
      const { rows } = await pool.query(`SELECT nome, valor, dia_vencimento FROM contas_fixas WHERE user_id=$1 AND ativo ORDER BY dia_vencimento`, [user.id]);
      if (!rows.length) return { reply: "Você ainda não tem contas fixas. Ex: *\"a luz vence todo dia 10, uns 180\"* 🙂", provider: "template" };
      const ls = rows.map((c) => `• dia ${String(c.dia_vencimento).padStart(2, "0")} — *${c.nome}*${c.valor ? ` (${brl(Number(c.valor))})` : ""}`);
      return { reply: `🧾 *Suas contas fixas:*\n${ls.join("\n")}`, provider: "template" };
    }
    case "remover_conta": {
      const alvo = String(intent.alvo || intent.titulo || "").trim();
      if (!alvo) return { reply: "Qual conta removo? Ex: *\"remove a conta de luz\"*", provider: "template" };
      const r = await pool.query(`DELETE FROM contas_fixas WHERE user_id=$1 AND nome ILIKE '%'||$2||'%' RETURNING nome`, [user.id, alvo]);
      if (!r.rowCount) return { reply: `Não achei a conta "${alvo}" 🤔 Manda *minhas contas* pra ver a lista.`, provider: "template" };
      return { reply: `🗑️ Conta *${r.rows[0].nome}* removida.`, provider: "template" };
    }

    // ── Meta por categoria ──────────────────────────────────
    case "definir_meta": {
      const cat = String(intent.categoria || "").trim().toLowerCase();
      const v = Number(intent.valor || 0);
      if (!cat || v <= 0) return { reply: "Me diz assim: *\"meta de 600 pra mercado\"* 🙂", provider: "template" };
      const up = await pool.query(`UPDATE categorias_usuario SET meta_valor=$3 WHERE user_id=$1 AND lower(nome)=lower($2)`, [user.id, cat, v]);
      if (!up.rowCount) await pool.query(`INSERT INTO categorias_usuario (user_id, nome, meta_valor) VALUES ($1,$2,$3)`, [user.id, cat, v]);
      return { reply: `🎯 Meta definida: até *${brl(v)}* em *${cat}* por mês. Te aviso quando chegar perto 😉`, provider: "template" };
    }

    // ── Lista de compras ────────────────────────────────────
    case "adicionar_lista": {
      const bruto = String(intent.titulo || "").trim();
      if (!bruto) return { reply: "O que eu coloco na lista? Ex: *\"põe leite na lista\"*", provider: "template" };
      const itens = bruto.split(/,| e /i).map((s) => s.trim()).filter(Boolean).slice(0, 15);
      for (const it of itens) await pool.query(`INSERT INTO lista_itens (user_id, item) VALUES ($1,$2)`, [user.id, it.slice(0, 60)]);
      return { reply: `🛒 Adicionei: *${itens.join("*, *")}*. Manda *ver lista* quando quiser conferir.`, provider: "template" };
    }
    case "ver_lista": {
      const { rows } = await pool.query(`SELECT item FROM lista_itens WHERE user_id=$1 ORDER BY created_at`, [user.id]);
      if (!rows.length) return { reply: "🛒 Sua lista está vazia. Ex: *\"põe leite na lista\"*", provider: "template" };
      return { reply: `🛒 *Sua lista:*\n${rows.map((r) => `• ${r.item}`).join("\n")}\n\n_(pra tirar: "tira o leite da lista" · "limpa a lista")_`, provider: "template" };
    }
    case "remover_lista": {
      const alvo = String(intent.alvo || "").trim();
      if (/^(tudo|toda|limpar?|td)$/i.test(alvo) || !alvo) {
        const r = await pool.query(`DELETE FROM lista_itens WHERE user_id=$1`, [user.id]);
        return { reply: `🧹 Lista limpa (${r.rowCount} item(ns) removidos).`, provider: "template" };
      }
      const r = await pool.query(`DELETE FROM lista_itens WHERE user_id=$1 AND item ILIKE '%'||$2||'%' RETURNING item`, [user.id, alvo]);
      if (!r.rowCount) return { reply: `Não achei "${alvo}" na lista 🤔`, provider: "template" };
      return { reply: `🗑️ Tirei *${r.rows[0].item}* da lista.`, provider: "template" };
    }

    // ── Editar / apagar (tira a fricção do erro) ────────────
    case "apagar_gasto": {
      const alvo = String(intent.alvo || "").trim().toLowerCase();
      let r;
      if (!alvo || /ultim|esse|este/.test(alvo)) {
        r = await pool.query(`DELETE FROM lancamentos WHERE id=(SELECT id FROM lancamentos WHERE user_id=$1 AND tipo='saida' ORDER BY created_at DESC LIMIT 1) RETURNING valor, categoria`, [user.id]);
      } else {
        const num = alvo.replace(",", ".").match(/\d+(\.\d+)?/);
        r = num
          ? await pool.query(`DELETE FROM lancamentos WHERE id=(SELECT id FROM lancamentos WHERE user_id=$1 AND tipo='saida' AND valor=$2 ORDER BY created_at DESC LIMIT 1) RETURNING valor, categoria`, [user.id, Number(num[0])])
          : await pool.query(`DELETE FROM lancamentos WHERE id=(SELECT id FROM lancamentos WHERE user_id=$1 AND tipo='saida' AND categoria ILIKE '%'||$2||'%' ORDER BY created_at DESC LIMIT 1) RETURNING valor, categoria`, [user.id, alvo]);
      }
      if (!r.rowCount) return { reply: "Não achei esse gasto 🤔 Manda *extrato* pra ver os últimos.", provider: "template" };
      return { reply: `🗑️ Apagado: *${brl(Number(r.rows[0].valor))}* em *${r.rows[0].categoria}*.`, provider: "template" };
    }
    case "apagar_tarefa": {
      const alvo = String(intent.alvo || "").trim();
      if (!alvo) return { reply: "Qual tarefa apago? Ex: *\"apaga a tarefa do dentista\"*", provider: "template" };
      const r = await pool.query(`DELETE FROM tarefas WHERE id=(SELECT id FROM tarefas WHERE user_id=$1 AND status='pendente' AND titulo ILIKE '%'||$2||'%' ORDER BY created_at DESC LIMIT 1) RETURNING titulo`, [user.id, alvo]);
      if (!r.rowCount) return { reply: `Não achei tarefa pendente parecida com "${alvo}" 🤔`, provider: "template" };
      return { reply: `🗑️ Tarefa *${r.rows[0].titulo}* apagada.`, provider: "template" };
    }
    case "editar_tarefa": {
      const alvo = String(intent.alvo || "").trim();
      if (!alvo || !intent.due_at) return { reply: "Me diz qual tarefa e o novo horário: ex *\"muda o dentista pra quinta 15h\"*", provider: "template" };
      const r = await pool.query(
        `UPDATE tarefas SET due_at=$3, lembrete_at=$3 WHERE id=(SELECT id FROM tarefas WHERE user_id=$1 AND status='pendente' AND titulo ILIKE '%'||$2||'%' ORDER BY created_at DESC LIMIT 1) RETURNING titulo, due_at`,
        [user.id, alvo, intent.due_at]
      );
      if (!r.rowCount) return { reply: `Não achei tarefa pendente parecida com "${alvo}" 🤔`, provider: "template" };
      const dt = new Date(r.rows[0].due_at).toLocaleString("pt-BR", { timeZone: user.timezone || config.APP_TIMEZONE, weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
      return { reply: `✏️ *${r.rows[0].titulo}* remarcada para *${dt}*. Lembrete ajustado ⏰`, provider: "template" };
    }
    case "adiar_lembrete": {
      const ult = await pool.query(
        `SELECT le.ref_id, t.titulo FROM lembretes_enviados le JOIN tarefas t ON t.id=le.ref_id
          WHERE le.user_id=$1 AND le.ref_tipo='tarefa' ORDER BY le.enviado_em DESC LIMIT 1`, [user.id]);
      if (!ult.rowCount) return { reply: "Não achei um lembrete recente pra adiar 🤔", provider: "template" };
      let novo: Date;
      if (intent.duracao_min && Number(intent.duracao_min) > 0) novo = new Date(Date.now() + Number(intent.duracao_min) * 60000);
      else if (intent.due_at) novo = new Date(intent.due_at);
      else novo = new Date(Date.now() + 30 * 60000);
      await pool.query(`UPDATE tarefas SET lembrete_at=$2, status='pendente' WHERE id=$1`, [ult.rows[0].ref_id, novo.toISOString()]);
      const dt = novo.toLocaleString("pt-BR", { timeZone: user.timezone || config.APP_TIMEZONE, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
      return { reply: `⏰ Combinado! Te lembro de *${ult.rows[0].titulo}* de novo em *${dt}*.`, provider: "template" };
    }

    // ── Resumos automáticos (opt-in) ────────────────────────
    case "configurar_resumo": {
      const tipo = /seman/i.test(String(intent.resumo_tipo || "")) ? "semanal" : "diario";
      const ligar = intent.ligar !== false;
      const col = tipo === "semanal" ? "resumo_semanal" : "resumo_diario";
      await pool.query(`UPDATE usuarios SET ${col}=$2 WHERE id=$1`, [user.id, ligar]);
      if (!ligar) return { reply: `🔕 Resumo ${tipo} desativado.`, provider: "template" };
      return { reply: tipo === "diario"
        ? `🌅 *Resumo diário ativado!* Todo dia às 7h te mando sua agenda, tarefas e finanças do dia. (pra parar: "desativa o resumo diário")`
        : `📊 *Resumo semanal ativado!* Todo domingo às 19h te mando o balanço da semana. (pra parar: "desativa o resumo semanal")`, provider: "template" };
    }

    // ── LGPD: apagar meus dados ─────────────────────────────
    case "apagar_meus_dados":
      return { reply:
        `⚠️ *Apagar todos os seus dados*\n\nIsso remove DE FORMA IRREVERSÍVEL: tarefas, rotinas, finanças, hábitos, contas, listas e histórico de conversas.\n\nSe tem certeza, responda exatamente:\n*APAGAR TUDO*`, provider: "template" };

    // ── CRM: vendas / meta / ranking ────────────────────────
    case "resumo_vendas": {
      if (!user.crm_email) return { reply: "O CRM não está ativado para você. Fale com o administrador 🙂", provider: "template" };
      const r = await resumoVendas(user.crm_email);
      if (!r.ok) return { reply: "Não consegui puxar suas vendas agora 😕 Tenta de novo em instantes.", provider: "template" };
      const por = (r.por_status || []).map((s: any) => `• ${statusPt(s.status)}: *${s.n}*${Number(s.total) > 0 ? ` (${brl(Number(s.total))})` : ""}`);
      const fm = r.fechados_mes || { n: 0, total: 0 };
      return { reply: `📈 *Suas vendas:*\n${por.join("\n") || "• nenhum lead ainda"}\n\n🏆 *Fechados este mês:* ${fm.n} (${brl(Number(fm.total))})`, provider: "template" };
    }
    case "minha_meta": {
      if (!user.crm_email) return { reply: "O CRM não está ativado para você. Fale com o administrador 🙂", provider: "template" };
      const r = await metaProgresso(user.crm_email);
      if (!r.ok) return { reply: "Não consegui consultar sua meta agora 😕", provider: "template" };
      if (!r.goal) return { reply: "Você ainda não tem meta definida este mês. Peça ao seu gerente pra cadastrar no painel 😉", provider: "template" };
      const g = r.goal, a = r.actual || {};
      const linhas: string[] = [];
      if (Number(g.target_closed) > 0) linhas.push(`🏆 Vendas: *${a.closed || 0}/${g.target_closed}*`);
      if (Number(g.target_revenue) > 0) {
        const pct = Math.min(100, Math.round((Number(a.revenue || 0) / Number(g.target_revenue)) * 100));
        linhas.push(`💰 Receita: *${brl(Number(a.revenue || 0))}* de ${brl(Number(g.target_revenue))} (${pct}%)`);
      }
      if (Number(g.target_leads) > 0) linhas.push(`👥 Leads novos: *${a.leads || 0}/${g.target_leads}*`);
      return { reply: `🎯 *Sua meta do mês:*\n${linhas.join("\n") || "meta cadastrada sem valores"}\n\nBora pra cima! 💪`, provider: "template" };
    }
    case "meu_ranking": {
      if (!user.crm_email) return { reply: "O CRM não está ativado para você. Fale com o administrador 🙂", provider: "template" };
      const r = await rankingPosicao(user.crm_email);
      if (!r.ok) return { reply: "Não consegui consultar o ranking agora 😕", provider: "template" };
      const top = (r.top || []).map((x: any, i: number) => `${["🥇", "🥈", "🥉"][i] || `${i + 1}º`} ${x.name} — ${x.vendas} venda(s)`);
      const pos = r.posicao ? `\n\n📍 Você está em *${r.posicao}º lugar* (${r.vendas} venda(s) no mês).` : "";
      return { reply: `🏁 *Ranking do mês:*\n${top.join("\n") || "sem vendas registradas ainda"}${pos}`, provider: "template" };
    }

    // ── Conversa / raciocínio → DeepSeek ───────────────────
    case "conversa":
    default: {
      // Fast-path: o classificador já devolveu a resposta na MESMA chamada
      // (corta ~1,5s e 1 chamada de LLM por mensagem de bate-papo).
      if (intent.resposta && String(intent.resposta).trim().length > 1) {
        return { reply: String(intent.resposta).trim(), provider: "deepseek" };
      }
      try {
        const reply = await deepseekChat([
          {
            role: "system",
            content:
              `Você é um assistente pessoal por WhatsApp (PT-BR), simpático e direto.\n` +
              `Agora é ${new Date().toLocaleString("pt-BR", { timeZone: config.APP_TIMEZONE })} (fuso ${config.APP_TIMEZONE}).\n\n` +
              `REGRAS IMPORTANTES (siga à risca):\n` +
              `1. NUNCA invente fatos, compromissos, horários, valores, nomes ou informações. Se você não tem o dado, diga claramente que não sabe ou peça pra pessoa informar.\n` +
              `2. Você cuida de: tarefas, rotinas, lembretes, planejamento da semana, agenda e finanças do próprio usuário.\n` +
              `3. NÃO confirme que agendou/anotou/lembrou algo aqui — isso é feito pelos comandos do sistema. Se a pessoa quer agendar, oriente-a a dizer algo como "marcar reunião amanhã às 15h"; se quer planejar, "monta meu plano da semana".\n` +
              `4. Use o histórico da conversa acima para entender o contexto e dar continuidade (não trate cada mensagem isolada).\n` +
              `5. Responda curto, no estilo de mensagem de WhatsApp.\n` +
              `6. Se pedirem cálculo, calcule e mostre só o resultado.\n` +
              `7. INFORMAÇÕES OFICIAIS (use somente quando perguntarem): você foi criado pela *Natela*; contato do criador: https://wa.me/11999990001 . Você ACEITA receber fotos, imagens e vídeos (ex: foto de comprovante que você lê e lança). Se perguntarem sobre bot/automação de ATENDIMENTO para empresa ou assistente personalizado: a Natela tem um *produto específico de atendimento* sob medida — passe o contato do criador pra criar o produto personalizado.`,
          },
          ...historico.slice(-8),
          { role: "user", content: textoOriginal || intent.descricao || "(sem texto)" },
        ]);
        return { reply: reply || "Pode repetir? 🙂", provider: "deepseek" };
      } catch {
        return { reply: "Tive um problema pra pensar nisso agora. Tenta de novo? 🙏", provider: "deepseek" };
      }
    }
  }
}

/**
 * Verifica se os gastos do mês na categoria estouraram (ou estão perto) da meta.
 * Retorna uma string de alerta (ou "" se não há meta / está tranquilo).
 */
async function checarMeta(userId: string, categoria: string): Promise<string> {
  const { rows } = await pool.query(
    `SELECT c.meta_valor,
            COALESCE((SELECT SUM(valor) FROM lancamentos l
                       WHERE l.user_id=c.user_id AND l.tipo='saida'
                         AND lower(l.categoria)=lower(c.nome)
                         AND date_trunc('month', l.ocorrido_em)=date_trunc('month', current_date)),0) AS gasto
       FROM categorias_usuario c
      WHERE c.user_id=$1 AND lower(c.nome)=lower($2) AND c.meta_valor IS NOT NULL
      LIMIT 1`,
    [userId, categoria]
  );
  if (!rows[0]) return "";
  const meta = Number(rows[0].meta_valor);
  const gasto = Number(rows[0].gasto);
  if (meta <= 0) return "";
  const pct = gasto / meta;
  if (pct >= 1) {
    return `\n\n🚨 *Atenção:* você já gastou ${brl(gasto)} em *${categoria}* este mês e a meta é ${brl(meta)}. Estourou em ${brl(gasto - meta)}.`;
  }
  if (pct >= 0.8) {
    return `\n\n⚠️ Você já usou ${Math.round(pct * 100)}% da meta de *${categoria}* (${brl(gasto)} de ${brl(meta)}).`;
  }
  return "";
}

// ──────────────────────────────────────────────────────────────
// Planejamento: cálculo de horários livres (em código, confiável)
// ──────────────────────────────────────────────────────────────
const DIAS_FULL_PT = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];

function hhmmToMin(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || "").trim());
  if (!m) return null;
  const h = Number(m[1]), mi = Number(m[2]);
  if (h > 23 || mi > 59) return null;
  return h * 60 + mi;
}
function minToHHMM(v: number): string {
  const h = Math.floor(v / 60), m = v % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
function weekdayInTz(date: Date, tz: string): number {
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(date);
  return ({ Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 } as Record<string, number>)[wd] ?? 0;
}
interface Bloco { ini: number; fim: number; titulo: string; }

/** Subtrai blocos ocupados de uma janela e devolve os intervalos livres (>= 30min). */
function calcularLivres(janelaIni: number, janelaFim: number, ocupados: Bloco[]): Array<{ ini: number; fim: number }> {
  const blocos = ocupados
    .map((b) => ({ ini: Math.max(b.ini, janelaIni), fim: Math.min(b.fim, janelaFim) }))
    .filter((b) => b.fim > b.ini)
    .sort((a, b) => a.ini - b.ini);
  const merged: Array<{ ini: number; fim: number }> = [];
  for (const b of blocos) {
    const last = merged[merged.length - 1];
    if (last && b.ini <= last.fim) last.fim = Math.max(last.fim, b.fim);
    else merged.push({ ini: b.ini, fim: b.fim });
  }
  const livres: Array<{ ini: number; fim: number }> = [];
  let cursor = janelaIni;
  for (const b of merged) {
    if (b.ini > cursor) livres.push({ ini: cursor, fim: b.ini });
    cursor = Math.max(cursor, b.fim);
  }
  if (cursor < janelaFim) livres.push({ ini: cursor, fim: janelaFim });
  return livres.filter((l) => l.fim - l.ini >= 30);
}

/** Monta o texto da agenda dos próximos 7 dias com livres já calculados. */
function montarAgendaSemana(rotinas: any[], tarefas: any[], tz: string, janelaIniStr: string, janelaFimStr: string): string {
  const jIni = hhmmToMin(janelaIniStr) ?? 480;
  const jFim = hhmmToMin(janelaFimStr) ?? 1080;
  const hoje = new Date();
  const linhas: string[] = [];
  const sameDay = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });

  for (let d = 0; d < 7; d++) {
    const dia = new Date(hoje.getTime() + d * 86400000);
    const wd = weekdayInTz(dia, tz);
    const label = DIAS_FULL_PT[wd] + (d === 0 ? " (hoje)" : d === 1 ? " (amanhã)" : "");
    const ocupados: Bloco[] = [];

    // rotinas do dia
    for (const r of rotinas) {
      const dias: number[] = Array.isArray(r.dias_semana) ? r.dias_semana.map(Number) : [];
      if (!dias.includes(wd)) continue;
      const ini = hhmmToMin(r.hora);
      if (ini == null) continue;
      const fim = hhmmToMin(r.hora_fim) ?? ini + 30; // sem fim = bloco de 30min
      ocupados.push({ ini, fim, titulo: r.titulo });
    }
    // tarefas com data nesse dia
    for (const t of tarefas) {
      const dt = new Date(t.due_at);
      if (sameDay.format(dt) !== sameDay.format(dia)) continue;
      const hhmm = new Intl.DateTimeFormat("pt-BR", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(dt);
      const ini = hhmmToMin(hhmm);
      if (ini == null) continue;
      ocupados.push({ ini, fim: ini + 30, titulo: t.titulo });
    }

    ocupados.sort((a, b) => a.ini - b.ini);
    const compromissos = ocupados.length
      ? ocupados.map((o) => `${minToHHMM(o.ini)}-${minToHHMM(o.fim)} ${o.titulo}`).join("; ")
      : "(livre o dia todo)";
    const livres = calcularLivres(jIni, jFim, ocupados);
    const livresTxt = livres.length ? livres.map((l) => `${minToHHMM(l.ini)}-${minToHHMM(l.fim)}`).join(", ") : "(sem janelas livres na jornada)";
    linhas.push(`${label}: compromissos: ${compromissos} | LIVRE: ${livresTxt}`);
  }
  return linhas.join("\n");
}

// ──────────────────────────────────────────────────────────────
// Períodos (financeiro / agenda)
// ──────────────────────────────────────────────────────────────
function ymd(d: Date): string { return d.toISOString().slice(0, 10); }

/** Intervalo de DATAS (YYYY-MM-DD) para relatório financeiro. Default: mês atual. */
function periodoRange(periodo?: string | null): { start: string; end: string } {
  const now = new Date();
  const p = (periodo || "").toLowerCase();
  if (p === "hoje") return { start: ymd(now), end: ymd(now) };
  if (p === "semana") { const s = new Date(now); s.setDate(s.getDate() - 7); return { start: ymd(s), end: ymd(now) }; }
  if (p === "mes_passado") { const s = new Date(now.getFullYear(), now.getMonth() - 1, 1); const e = new Date(now.getFullYear(), now.getMonth(), 0); return { start: ymd(s), end: ymd(e) }; }
  // mes_atual (default)
  const s = new Date(now.getFullYear(), now.getMonth(), 1);
  return { start: ymd(s), end: ymd(now) };
}

/** Intervalo de DATA-HORA (ISO) para listar agendamentos. Default: próximos 30 dias. */
function agendaRange(periodo?: string | null): { start: string; end: string } {
  const now = new Date();
  const p = (periodo || "").toLowerCase();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  if (p === "hoje") { const e = new Date(startOfToday); e.setDate(e.getDate() + 1); return { start: startOfToday.toISOString(), end: e.toISOString() }; }
  if (p === "amanha" || p === "amanhã") { const s = new Date(startOfToday); s.setDate(s.getDate() + 1); const e = new Date(s); e.setDate(e.getDate() + 1); return { start: s.toISOString(), end: e.toISOString() }; }
  if (p === "semana") { const e = new Date(now); e.setDate(e.getDate() + 7); return { start: now.toISOString(), end: e.toISOString() }; }
  const e = new Date(now); e.setDate(e.getDate() + 30);
  return { start: now.toISOString(), end: e.toISOString() };
}
