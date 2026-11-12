import { groqChat, type ChatMsg } from "./groq";
import { deepseekChat } from "./deepseek";
import { config } from "../config";
import { log } from "../log";

export type Intent =
  | "criar_tarefa"
  | "criar_rotina"
  | "listar_hoje"
  | "concluir_tarefa"
  | "registrar_gasto"
  | "registrar_entrada"
  | "consultar_saldo"
  | "extrato"
  | "relatorio_semanal"
  | "criar_lead"
  | "listar_leads"
  | "consultar_lead"
  | "atualizar_lead_status"
  | "anotar_lead"
  | "registrar_pagamento"
  | "consultar_pagamentos"
  | "relatorio_financeiro"
  | "criar_agendamento"
  | "listar_agendamentos"
  | "exportar_relatorio"
  | "clima"
  | "cotacao"
  | "criar_habito"
  | "registrar_habito"
  | "listar_habitos"
  | "consultar_agenda"
  | "planejar_semana"
  | "preencher_contrato"
  | "criar_conta_fixa"
  | "listar_contas"
  | "remover_conta"
  | "definir_meta"
  | "adicionar_lista"
  | "ver_lista"
  | "remover_lista"
  | "apagar_gasto"
  | "apagar_tarefa"
  | "editar_tarefa"
  | "adiar_lembrete"
  | "configurar_resumo"
  | "apagar_meus_dados"
  | "resumo_vendas"
  | "minha_meta"
  | "meu_ranking"
  | "ajuda"
  | "conversa";

export interface IntentResult {
  intent: Intent;
  titulo?: string;
  due_at?: string | null; // ISO local
  lembrete_at?: string | null;
  dias_semana?: number[]; // 0=dom
  hora?: string | null; // HH:MM (início)
  hora_fim?: string | null; // HH:MM (fim do bloco, ex: trabalho 8 às 17)
  valor?: number | null;
  categoria?: string | null;
  descricao?: string | null;
  alvo?: string | null; // p/ concluir_tarefa: texto que identifica a tarefa
  // criar_lead (CRM)
  lead_nome?: string | null;
  lead_telefone?: string | null;
  lead_interesse?: string | null;
  lead_valor?: number | null;
  lead_pagamento?: string | null;
  // gestão de leads (CRM)
  lead_alvo?: string | null;    // nome/telefone que identifica o lead a consultar/atualizar
  lead_status?: string | null;  // status alvo (novo/contatado/visita/negociando/fechado/perdido)
  lead_nota?: string | null;    // texto da anotação/interação
  // pagamentos / agenda (CRM)
  metodo_pagamento?: string | null; // pix/boleto/cartao/dinheiro
  data_pagamento?: string | null;   // YYYY-MM-DD
  periodo?: string | null;          // "mes_atual" | "mes_passado" | "hoje" | "semana" | null
  agend_titulo?: string | null;     // título do agendamento
  agend_data_iso?: string | null;   // data/hora ISO do agendamento
  cidade?: string | null; // p/ clima
  janela_inicio?: string | null; // HH:MM jornada do usuario (planejar_semana)
  janela_fim?: string | null;    // HH:MM
  resposta?: string | null; // p/ intent=conversa: resposta direta (evita 2a chamada de LLM)
  dia_vencimento?: number | null; // criar_conta_fixa (1-31)
  duracao_min?: number | null;    // adiar_lembrete ("adia 30 min" -> 30)
  resumo_tipo?: string | null;    // configurar_resumo: "diario" | "semanal"
  ligar?: boolean | null;         // configurar_resumo: true=ativar false=desativar
  confianca?: number; // 0..1
}

const INTENTS = [
  "criar_tarefa",
  "criar_rotina",
  "listar_hoje",
  "concluir_tarefa",
  "registrar_gasto",
  "registrar_entrada",
  "consultar_saldo",
  "extrato",
  "relatorio_semanal",
  "clima",
  "cotacao",
  "criar_habito",
  "registrar_habito",
  "listar_habitos",
  "consultar_agenda",
  "planejar_semana",
  "registrar_pagamento",
  "consultar_pagamentos",
  "relatorio_financeiro",
  "criar_agendamento",
  "listar_agendamentos",
  "exportar_relatorio",
  "criar_lead",
  "listar_leads",
  "consultar_lead",
  "atualizar_lead_status",
  "anotar_lead",
  "preencher_contrato",
  "criar_conta_fixa",
  "listar_contas",
  "remover_conta",
  "definir_meta",
  "adicionar_lista",
  "ver_lista",
  "remover_lista",
  "apagar_gasto",
  "apagar_tarefa",
  "editar_tarefa",
  "adiar_lembrete",
  "configurar_resumo",
  "apagar_meus_dados",
  "resumo_vendas",
  "minha_meta",
  "meu_ranking",
  "ajuda",
  "conversa",
];

function nowInfo(tz: string): string {
  const fmt = new Intl.DateTimeFormat("pt-BR", {
    timeZone: tz,
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  return fmt.format(new Date());
}

/**
 * Classifica a intenção e extrai entidades via Groq (rápido, grátis).
 * Retorna JSON estruturado. Datas relativas resolvidas com a data atual no prompt.
 */
export async function classify(texto: string, tz = config.APP_TIMEZONE, historico: ChatMsg[] = []): Promise<IntentResult> {
  // Parte ESTÁTICA primeiro (cacheável pelo DeepSeek — prefix caching); data/hora só no fim.
  const sys = `Você é um classificador de intenções de um assistente pessoal por WhatsApp (PT-BR).
Responda SOMENTE com um JSON válido, sem texto extra.

Intenções possíveis: ${INTENTS.join(", ")}.

⚠️ REGRA DE OURO — NUNCA invente nada:
- Extraia SOMENTE o que está literalmente escrito na mensagem do usuário.
- "titulo" deve ser as PRÓPRIAS PALAVRAS do usuário. Ex: usuário diz "aulas de dança" → titulo="aulas de dança"; diz "pilates" → titulo="pilates".
- JAMAIS use palavras de exemplo deste prompt (como "dentista", "reunião", "academia", "Maria") se o usuário não as disse.
- Se uma informação (título, data, hora, dias, valor, nome) NÃO foi dita, use null. NÃO chute, NÃO complete.
- Se você não tem certeza da intenção (confianca < 0.6), use intent="conversa".

Regras por intenção:
- criar_tarefa: "titulo" (palavras do usuário), "due_at" (ISO local "YYYY-MM-DDTHH:mm" só se data/hora forem ditas), "lembrete_at" (igual due_at, ou antes se pedirem).
- criar_rotina: o usuário quer um compromisso/bloco recorrente. "titulo" (palavras do usuário), "dias_semana" (array 0=dom..6=sáb), "hora" (início "HH:mm"), "hora_fim" (fim "HH:mm" quando for um INTERVALO, ex: "trabalho de seg a sex das 8 às 17" → hora="08:00", hora_fim="17:00"). Se misturar dias com HORÁRIOS DIFERENTES (ex: "terça 18h e quinta 12h"), use intent="conversa" e peça pra separar.
- planejar_semana: quando o usuário pede pra MONTAR/ORGANIZAR/PLANEJAR a semana ou o dia, encaixar tarefas, distribuir compromissos, ou pede sugestão de como organizar a rotina (ex: "monta meu plano da semana", "me ajuda a organizar a semana", "como encaixo academia e estudo"). Se ele informar a jornada/horário que tem livre, extraia "janela_inicio" e "janela_fim" (HH:MM).
- consultar_agenda: quando o usuário PERGUNTA sobre a própria agenda/semana — "como está minha agenda", "o que tenho na quinta", "quais horários livres tenho", "estou livre amanhã?". NÃO crie nada; é só consulta. Sem campos extras.
- registrar_gasto / registrar_entrada: "valor" (number dito), "categoria", "descricao".
- concluir_tarefa: "alvo" (o que o usuário disse que concluiu).
- criar_lead: cadastro de lead/cliente no CRM. "lead_nome", "lead_telefone" (só dígitos), "lead_interesse", "lead_valor", "lead_pagamento".
- listar_leads: o usuário quer VER seus leads do CRM (ex: "meus leads", "quais leads eu tenho", "lista meus clientes", "leads em negociação"). Se citar um status, extraia "lead_status" (novo/contatado/visita/negociando/fechado/perdido). Sem outros campos.
- consultar_lead: o usuário pergunta sobre UM lead específico (ex: "como está o lead do João?", "status do cliente Maria", "me fala do lead 61 99999-9999"). Extraia "lead_alvo" (nome ou telefone dito).
- atualizar_lead_status: mudar o status/etapa de um lead (ex: "muda o lead do João pra negociando", "marca a Maria como fechado", "o cliente Pedro virou perdido"). Extraia "lead_alvo" (quem) e "lead_status" (novo/contatado/visita/negociando/fechado/perdido).
- anotar_lead: registrar uma nota/interação num lead (ex: "anota no lead do João que liguei e ele pediu desconto", "registra que a Maria quer visitar sábado"). Extraia "lead_alvo" (quem) e "lead_nota" (o texto a anotar).
- registrar_pagamento: o usuário registrou/recebeu um pagamento de um cliente/lead (ex: "recebi 5 mil no pix do lead João", "lança um pagamento de 2000 boleto do cliente Maria", "o Pedro pagou 1500 em dinheiro hoje"). Extraia "lead_alvo" (de quem), "valor" (number), "metodo_pagamento" (pix/boleto/cartao/dinheiro) e "data_pagamento" (YYYY-MM-DD se citada, senão null = hoje).
- consultar_pagamentos: ver pagamentos de UM cliente/lead específico (ex: "quanto o João já pagou?", "pagamentos da Maria"). Extraia "lead_alvo" e, se citar período, "periodo".
- relatorio_financeiro: relatório de PAGAMENTOS de leads do CRM (vendas/comissão). SÓ use quando a mensagem deixar CLARO que é do CRM/vendas — ex: "relatório financeiro dos leads", "quanto recebi dos clientes", "total de vendas", "meu faturamento de vendas". Extraia "periodo" (mes_atual/mes_passado/hoje/semana) se dito. NÃO use pra finanças pessoais.
- relatorio_semanal: resumo PESSOAL da semana (gastos, entradas e tarefas do próprio usuário). Use pra pedidos genéricos: "relatório", "resumo da semana", "relatório da semana", "como foi minha semana" — quando NÃO ficar claro que é de vendas/CRM.
- criar_agendamento: marcar uma visita/reunião/agendamento COM UM CLIENTE no CRM (ex: "agenda uma visita com o João sábado às 10h", "marca reunião com a Maria amanhã 15h no stand"). Extraia "lead_alvo" (com quem), "agend_titulo" (ex: "Visita", "Reunião"), "agend_data_iso" (ISO 8601 com data+hora) e "descricao" (detalhes/local se houver). NÃO confunda com criar_tarefa (tarefa pessoal sem cliente) nem criar_agendamento sem cliente.
- listar_agendamentos: ver os agendamentos/visitas do corretor no CRM (ex: "minha agenda de amanhã", "próximas visitas", "o que tenho agendado essa semana", "agenda da semana"). Extraia "periodo" se dito (hoje/amanha/semana).
- exportar_relatorio: o usuário pede o RELATÓRIO em ARQUIVO/planilha (ex: "me manda o relatório", "exporta meus leads", "relatório em excel", "manda a planilha de leads", "quero o relatório em arquivo"). Diferente de relatorio_financeiro (que é um resumo de pagamentos em texto). Sem campos extras.
- preencher_contrato: o usuário quer GERAR/PREENCHER um contrato de intermediação/venda automaticamente (ex: "preenche um contrato", "gerar contrato", "fazer o contrato do cliente", "monta o contrato de intermediação", "quero gerar um contrato"). Sem campos extras.
- criar_conta_fixa: conta RECORRENTE com dia de vencimento (ex: "a luz vence todo dia 10, uns 180 reais", "internet dia 5, 99,90"). "titulo"=nome da conta, "valor" (number|null), "dia_vencimento" (1-31).
- listar_contas: ver as contas fixas ("minhas contas", "quais contas eu tenho").
- remover_conta: apagar uma conta fixa ("remove a conta de luz"). "alvo"=qual.
- definir_meta: meta de gasto por categoria (ex: "quero gastar no máximo 600 no mercado", "meta de 200 pra transporte"). "categoria", "valor" (number).
- adicionar_lista: adicionar item(ns) à lista de compras (ex: "põe leite na lista", "adiciona arroz e feijão na lista"). "titulo"=os itens ditos.
- ver_lista: ver a lista de compras ("o que tem na lista?", "minha lista").
- remover_lista: tirar item ou limpar (ex: "tira o leite da lista", "limpa a lista"). "alvo"=item dito, ou "tudo" se pediu pra limpar.
- apagar_gasto: excluir um lançamento financeiro (ex: "apaga esse gasto", "exclui o gasto de 50", "lancei errado, apaga o último"). "alvo"=o que identifica (valor/descrição) ou "ultimo".
- apagar_tarefa: excluir uma tarefa SEM concluir (ex: "apaga a tarefa do dentista", "cancela o dentista"). "alvo"=qual.
- editar_tarefa: mudar data/hora de uma tarefa (ex: "muda o dentista pra quinta 15h", "adia a reunião pra amanhã 10h"). "alvo"=qual tarefa, "due_at"=nova data/hora ISO.
- adiar_lembrete: adiar o ÚLTIMO lembrete recebido (ex: "adia 30 min", "me lembra de novo em 1 hora", "me lembra amanhã às 9"). "duracao_min" (number de minutos) OU "due_at" (ISO se disse horário).
- configurar_resumo: ligar/desligar resumo automático (ex: "ativa o resumo diário", "quero o bom dia todo dia", "desativa o resumo semanal"). "resumo_tipo"="diario"|"semanal", "ligar"=true/false.
- apagar_meus_dados: o usuário pede pra apagar TODOS os dados dele / sair / LGPD (ex: "apaga tudo que você sabe de mim", "quero excluir meus dados"). Sem campos.
- resumo_vendas: panorama de vendas/funil do CRM (ex: "como estão minhas vendas?", "meu funil", "resumo dos meus leads"). Sem campos.
- minha_meta: progresso da meta de VENDAS do mês no CRM (ex: "quanto falta pra minha meta?", "como tá minha meta do mês"). Sem campos.
- meu_ranking: posição no ranking de corretores (ex: "como tá o ranking?", "em que lugar eu tô?"). Sem campos.
- clima: previsão/tempo. Extraia "cidade" se mencionada (ex: "clima em Goiânia" → cidade="Goiânia"); senão null.
- cotacao: cotação de dólar, euro, bitcoin/cripto, moedas. Sem campos extras.
- criar_habito: criar um HÁBITO pessoal recorrente, SEM dia/hora fixos (ex: "quero criar o hábito de beber água", "meta de ler todo dia"). "titulo" = o hábito. NÃO confunda com criar_rotina (que tem dia + horário).
- registrar_habito: a pessoa CUMPRIU um hábito hoje (ex: "já bebi água", "fiz a leitura hoje", "treinei"). "alvo" = qual hábito.
- listar_habitos: ver os hábitos e as sequências (ex: "meus hábitos", "como tá minha sequência").
- listar_hoje, consultar_saldo, extrato, relatorio_semanal, ajuda: sem campos extras.
- conversa: bate-papo, pergunta aberta, ou qualquer coisa ambígua/incerta. NESTE caso inclua também "resposta": sua resposta direta ao usuário (PT-BR, simpática, estilo WhatsApp, curta). Regras da resposta: NUNCA invente fatos/compromissos/horários/valores; NÃO confirme que agendou/anotou algo (oriente a pessoa: ex "é só dizer marcar reunião amanhã às 15h"); use o histórico p/ dar continuidade; se pedirem cálculo, calcule e mostre só o resultado; se não souber, diga que não sabe.
  INFORMAÇÕES OFICIAIS (use SOMENTE quando perguntarem): você foi criado pela *Natela*; contato do criador: https://wa.me/11999990001 . Você ACEITA receber fotos, imagens e vídeos (ex: foto de comprovante/nota que você lê e lança). Se perguntarem sobre bot/automação de ATENDIMENTO para empresa ou um assistente personalizado: diga que a Natela tem um *produto específico de atendimento*, feito sob medida pra necessidade do cliente, e passe o contato do criador (https://wa.me/11999990001) pra criar o produto personalizado.
- Resolva datas relativas ("amanhã", "terça que vem") com base na data/hora atual.
- "confianca" (0 a 1): quão certo você está.

Responda em JSON com os campos que se aplicam; use null nos que não foram ditos. Sem texto fora do JSON.
Data/hora atual (${tz}): ${nowInfo(tz)}.`;

  try {
    // Histórico recente entra como contexto p/ resolver referências ("às 15h", "pode marcar").
    const messages: ChatMsg[] = [
      { role: "system", content: sys },
      ...historico.slice(-8),
      { role: "user", content: texto },
    ];
    // DeepSeek é o orquestrador principal (confiável, sem rate-limit apertado).
    // Groq 70b entra só como reserva se o DeepSeek falhar.
    let raw: string;
    try {
      raw = await deepseekChat(messages, { json: true, temperature: 0 });
    } catch (e) {
      log("warn", "intent: deepseek falhou, tentando groq", { err: String(e) });
      raw = await groqChat(messages, { model: config.GROQ_CHAT_MODEL, json: true, temperature: 0 });
    }
    const parsed = JSON.parse(raw);
    if (!INTENTS.includes(parsed.intent)) parsed.intent = "conversa";
    // Rede de segurança: intenções que CRIAM dados exigem confiança mínima.
    // Se o modelo não tem certeza, vira conversa (pede esclarecimento) em vez de inventar.
    const criaDados = ["criar_tarefa", "criar_rotina", "registrar_gasto", "registrar_entrada", "criar_lead"];
    if (criaDados.includes(parsed.intent) && typeof parsed.confianca === "number" && parsed.confianca < 0.55) {
      parsed.intent = "conversa";
    }
    // criar_tarefa/rotina sem título extraído = não cria (evita alucinação).
    if ((parsed.intent === "criar_tarefa" || parsed.intent === "criar_rotina") && !String(parsed.titulo || "").trim()) {
      parsed.intent = "conversa";
    }
    return parsed as IntentResult;
  } catch (err) {
    log("warn", "intent: classify falhou, caindo p/ conversa", { err: String(err) });
    return { intent: "conversa", confianca: 0 };
  }
}
