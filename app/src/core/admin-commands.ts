import { pool } from "../db";
import type { Usuario } from "./allowlist";
import { instanceStatus } from "../evolution/client";
import { enviarBoasVindas } from "./welcome";

const VALIDADE_PADRAO_DIAS = 30;

/** É um usuário admin? (plano='admin') */
export function isAdmin(user: Usuario | null): boolean {
  return !!user && user.plano === "admin";
}

function brl(v: number): string {
  return Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
function fdate(d: any): string {
  if (!d) return "—";
  try { return new Date(d).toLocaleDateString("pt-BR"); } catch { return String(d); }
}

const MENU =
  `🛠️ *Painel Admin*\n\n` +
  `Comandos disponíveis:\n` +
  `• *cadastrar 5561999998888 Nome* — novo assinante (30 dias)\n` +
  `• *assinantes* — total, ativos e vencidos\n` +
  `• *pagamentos* — quem está em dia / vencido\n` +
  `• *uso indevido* — risco de ban (não-assinantes + flood)\n` +
  `• *agente* — status do bot e uso das funções\n` +
  `• *vencendo* — assinaturas que vencem em breve\n\n` +
  `_Você também usa normalmente: tarefas, rotinas e finanças._`;

/**
 * Se o texto for um comando de admin, processa e retorna a resposta.
 * Se não for comando admin, retorna null (segue fluxo normal).
 */
export async function tryAdminCommand(texto: string): Promise<string | null> {
  const t = texto.trim().toLowerCase();

  // menu
  if (t === "admin" || t === "menu" || t === "/admin") return MENU;

  // cadastrar novo assinante: "cadastrar 5561999998888 Fulano de Tal"
  if (/^(cadastrar|cadastra|novo|add)\b/i.test(t)) {
    const resto = texto.trim().replace(/^(cadastrar|cadastra|novo|add)\s*/i, "");
    const m = resto.match(/(\+?\d[\d\s().-]{8,})/); // captura o telefone
    if (!m) return `Pra cadastrar, me manda assim:\n*cadastrar 5561999998888 Nome do assinante*`;
    const phone = m[1].replace(/[^\d]/g, "");
    if (phone.length < 10) return `Telefone inválido. Use DDI+DDD, ex:\n*cadastrar 5561999998888 Nome*`;
    const nome = resto.replace(m[1], "").trim() || null;

    // validade padrão = hoje + 30 dias
    const d = new Date(); d.setDate(d.getDate() + VALIDADE_PADRAO_DIAS);
    const ate = d.toISOString().slice(0, 10);

    try {
      const ins = await pool.query(
        `INSERT INTO usuarios (phone, nome, status, plano, assinatura_ate)
         VALUES ($1,$2,'ativo','free',$3) RETURNING id, phone, nome`,
        [phone, nome, ate]
      );
      const u = ins.rows[0];
      // tenta enviar boas-vindas (best-effort)
      let bv = "";
      try { const ok = await enviarBoasVindas(u.id, u.phone, u.nome, true); bv = ok ? "\n📨 Boas-vindas enviada." : "\n⚠️ Boas-vindas não enviou (WhatsApp conectado?)."; } catch { /* */ }
      return `✅ Assinante cadastrado!\n👤 ${u.nome || u.phone}\n📱 ${u.phone}\n🗓️ Válido até ${fdate(ate)} (30 dias).${bv}`;
    } catch (e: any) {
      if (String(e?.code) === "23505") return `Esse telefone já está cadastrado.`;
      return `Não consegui cadastrar: ${String(e?.message || e).slice(0, 120)}`;
    }
  }

  // assinantes (visão geral)
  if (t === "assinantes" || t === "resumo") {
    const { rows } = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE plano<>'admin') AS total,
        COUNT(*) FILTER (WHERE status='ativo' AND plano<>'admin') AS ativos,
        COUNT(*) FILTER (WHERE plano<>'admin' AND assinatura_ate IS NOT NULL AND assinatura_ate < current_date) AS vencidos,
        COUNT(*) FILTER (WHERE status<>'ativo' AND plano<>'admin') AS inativos
      FROM usuarios`);
    const r = rows[0];
    return `👥 *Assinantes*\n\n` +
      `Total: *${r.total}*\n` +
      `🟢 Ativos: ${r.ativos}\n` +
      `🔴 Vencidos: ${r.vencidos}\n` +
      `⚫ Inativos/suspensos: ${r.inativos}`;
  }

  // pagamentos (em dia x vencidos, com nomes)
  if (t === "pagamentos" || t === "quem pagou" || t === "quem nao pagou" || t === "quem não pagou") {
    const emDia = await pool.query(`
      SELECT nome, phone, assinatura_ate FROM usuarios
       WHERE plano<>'admin' AND status='ativo'
         AND (assinatura_ate IS NULL OR assinatura_ate >= current_date)
       ORDER BY assinatura_ate NULLS LAST LIMIT 40`);
    const vencidos = await pool.query(`
      SELECT nome, phone, assinatura_ate FROM usuarios
       WHERE plano<>'admin' AND assinatura_ate IS NOT NULL AND assinatura_ate < current_date
       ORDER BY assinatura_ate LIMIT 40`);
    const linhaEmDia = emDia.rows.map((u: any) =>
      `• ${u.nome || u.phone} — vence ${u.assinatura_ate ? fdate(u.assinatura_ate) : "sem data"}`).join("\n") || "_ninguém_";
    const linhaVenc = vencidos.rows.map((u: any) =>
      `• ${u.nome || u.phone} — venceu ${fdate(u.assinatura_ate)}`).join("\n") || "_ninguém_";
    return `💳 *Pagamentos*\n\n` +
      `✅ *Em dia (${emDia.rowCount}):*\n${linhaEmDia}\n\n` +
      `❌ *Vencidos (${vencidos.rowCount}):*\n${linhaVenc}`;
  }

  // uso indevido (risco de ban)
  if (t === "uso indevido" || t === "ban" || t === "risco" || t === "seguranca" || t === "segurança") {
    // 1) não-assinantes que tentaram usar (últimos 7 dias)
    const naoAssin = await pool.query(`
      SELECT phone, COUNT(*) AS tentativas, MAX(created_at) AS ultima
        FROM tentativas_indevidas
       WHERE created_at >= now() - interval '7 days'
       GROUP BY phone ORDER BY tentativas DESC LIMIT 15`);
    // 2) flood: assinantes com volume anormal nas últimas 24h (msgs recebidas)
    const flood = await pool.query(`
      SELECT m.phone, COALESCE(u.nome, m.phone) AS nome, COUNT(*) AS msgs
        FROM mensagens m LEFT JOIN usuarios u ON u.id = m.user_id
       WHERE m.direcao='in' AND m.created_at >= now() - interval '24 hours'
       GROUP BY m.phone, u.nome
      HAVING COUNT(*) >= 50
       ORDER BY msgs DESC LIMIT 15`);
    // 3) vencidos ainda mandando mensagem (24h)
    const vencTentando = await pool.query(`
      SELECT COALESCE(u.nome,m.phone) AS nome, COUNT(*) AS msgs
        FROM mensagens m JOIN usuarios u ON u.id=m.user_id
       WHERE m.direcao='in' AND m.created_at >= now() - interval '24 hours'
         AND u.assinatura_ate IS NOT NULL AND u.assinatura_ate < current_date
       GROUP BY u.nome, m.phone ORDER BY msgs DESC LIMIT 15`);

    const lNao = naoAssin.rows.map((r: any) =>
      `• ${r.phone} — ${r.tentativas}x (últ. ${fdate(r.ultima)})`).join("\n") || "_nenhum_";
    const lFlood = flood.rows.map((r: any) =>
      `• ${r.nome} — ${r.msgs} msgs/24h ⚠️`).join("\n") || "_nenhum_";
    const lVenc = vencTentando.rows.map((r: any) =>
      `• ${r.nome} — ${r.msgs} msgs`).join("\n") || "_nenhum_";

    return `🚨 *Uso indevido / risco de ban*\n\n` +
      `🚫 *Não-assinantes tentando (7d):*\n${lNao}\n\n` +
      `⚡ *Flood — volume alto (24h, ≥50):*\n${lFlood}\n\n` +
      `⏰ *Vencidos ainda mandando msg (24h):*\n${lVenc}\n\n` +
      `_Dica: muitos envios/contatos novos aumentam o risco de bloqueio do WhatsApp._`;
  }

  // agente: status + uso das funções
  if (t === "agente" || t === "disponibilidade" || t === "status") {
    let conexao = "desconhecido";
    try { const s: any = await instanceStatus(); conexao = s?.instance?.state || s?.state || "desconhecido"; } catch { /* */ }
    const { rows } = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM tarefas WHERE status='pendente') AS tarefas_pend,
        (SELECT COUNT(*) FROM tarefas WHERE status='concluida') AS tarefas_feitas,
        (SELECT COUNT(*) FROM rotinas WHERE ativa) AS rotinas_ativas,
        (SELECT COUNT(*) FROM lancamentos WHERE created_at >= current_date - 7) AS lanc_7d,
        (SELECT COUNT(*) FROM mensagens WHERE created_at >= now() - interval '24 hours') AS msgs_24h`);
    const r = rows[0];
    const conTxt = conexao === "open" ? "🟢 Conectado" : `🔴 ${conexao}`;
    return `🤖 *Status do Agente*\n\n` +
      `WhatsApp: ${conTxt}\n\n` +
      `📋 Tarefas pendentes: ${r.tarefas_pend}\n` +
      `✅ Tarefas concluídas: ${r.tarefas_feitas}\n` +
      `🔁 Rotinas ativas: ${r.rotinas_ativas}\n` +
      `💸 Lançamentos (7d): ${r.lanc_7d}\n` +
      `💬 Mensagens (24h): ${r.msgs_24h}`;
  }

  // vencendo: próximas assinaturas a vencer
  if (t === "vencendo" || t === "vencimentos") {
    const { rows } = await pool.query(`
      SELECT nome, phone, assinatura_ate,
             (assinatura_ate - current_date) AS dias
        FROM usuarios
       WHERE plano<>'admin' AND status='ativo' AND assinatura_ate IS NOT NULL
         AND assinatura_ate BETWEEN current_date AND current_date + 7
       ORDER BY assinatura_ate LIMIT 30`);
    if (rows.length === 0) return `📅 Nenhuma assinatura vencendo nos próximos 7 dias.`;
    const linhas = rows.map((u: any) => {
      const d = Number(u.dias);
      const q = d === 0 ? "hoje" : d === 1 ? "amanhã" : `em ${d} dias`;
      return `• ${u.nome || u.phone} — ${q} (${fdate(u.assinatura_ate)})`;
    });
    return `📅 *Vencendo nos próximos 7 dias:*\n${linhas.join("\n")}`;
  }

  return null; // não é comando admin → segue fluxo normal
}
