import { sendText } from "../evolution/client";
import { pool } from "../db";

function primeiroNome(nome: string | null): string {
  if (!nome) return "";
  return " " + nome.trim().split(/\s+/)[0];
}

export function textoBoasVindas(nome: string | null, ehCrm = false): string {
  if (ehCrm) {
    return (
      `Olá${primeiroNome(nome)}! 👋 Eu sou o seu *Assistente de Vendas* aqui no WhatsApp.\n\n` +
      `Você fala comigo por *mensagem ou áudio* e tudo cai no seu *CRM*. Veja o que eu faço:\n\n` +
      `👥 *Leads* — "cadastra um lead", "meus leads", "como está o lead do João?"\n` +
      `💰 *Pagamentos* — "recebi 5 mil no pix do João"\n` +
      `📅 *Visitas* — "agenda visita com a Maria sábado 10h"\n` +
      `📄 *Contrato* — "preenche um contrato" (manda a foto do RG, eu gero o PDF)\n` +
      `📊 *Relatórios* — "relatório financeiro", "exporta meus leads"\n` +
      `🎙️ *Voz* — diga "responde em áudio" ou "prefiro texto"\n\n` +
      `Manda *ajuda* a qualquer momento pra ver o guia completo. Bora vender? 🚀`
    );
  }
  return (
    `Olá${primeiroNome(nome)}! 👋 Eu sou o seu *Assistente Pessoal* aqui no WhatsApp.\n\n` +
    `Você fala comigo por *mensagem ou áudio*. Veja o que eu faço:\n\n` +
    `📋 *Tarefas* — "dentista terça 15h", "o que tenho hoje?"\n` +
    `🔁 *Rotinas* — "academia seg/qua/sex 7h"\n` +
    `💸 *Finanças* — "gastei 50 no mercado", "qual meu saldo?"\n` +
    `📷 *Comprovante por foto* — manda a foto da nota que eu lanço\n` +
    `📊 *Controle por planilha* — envie um Excel com categorias/metas\n` +
    `🎙️ *Voz* — diga "responde em áudio" ou "prefiro texto"\n` +
    `📅 *Relatórios* — "resumo da semana"\n\n` +
    `Manda *ajuda* a qualquer momento pra ver o guia completo. Bora começar? 🙂`
  );
}

/**
 * Envia a mensagem de boas-vindas e marca como enviada.
 * IDEMPOTENTE: por padrão NÃO reenvia se o usuário já recebeu (evita boas-vindas duplicada).
 * Use forcar=true só para reenvio manual explícito (botão no painel).
 */
export async function enviarBoasVindas(userId: string, phone: string, nome: string | null, forcar = false): Promise<boolean> {
  const { rows } = await pool.query(`SELECT welcome_enviada, crm_email, crm_ativo FROM usuarios WHERE id=$1`, [userId]);
  if (!forcar && rows[0]?.welcome_enviada) return false; // já recebeu — não manda de novo
  const ehCrm = Boolean(rows[0]?.crm_email) || Boolean(rows[0]?.crm_ativo);
  const ok = await sendText(phone, textoBoasVindas(nome, ehCrm));
  if (ok) await pool.query(`UPDATE usuarios SET welcome_enviada=true WHERE id=$1`, [userId]);
  return ok;
}
