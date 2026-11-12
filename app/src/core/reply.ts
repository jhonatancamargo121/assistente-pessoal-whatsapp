import { pool } from "../db";
import type { Usuario } from "./allowlist";
import { sendText, sendAudio } from "../evolution/client";
import { sintetizar } from "../ai/tts";
import { elevenLabsConfigurado } from "../ai/elevenlabs";
import { log } from "../log";

/**
 * Decide se este usuário recebe a VOZ PREMIUM (ElevenLabs).
 * Regras (precisa da chave ELEVENLABS_API_KEY configurada):
 *   - número está em ELEVEN_CANARY_PHONES (lista CSV) → canário/teste
 *   - OU ELEVEN_FOR_BUSINESS=true e o plano do usuário é "business"
 */
function vozPremium(user: Usuario): boolean {
  if (!elevenLabsConfigurado()) return false;
  const fone = String(user.phone || "").replace(/\D/g, "");
  const canary = String(process.env.ELEVEN_CANARY_PHONES || "")
    .split(",")
    .map((s) => s.replace(/\D/g, ""))
    .filter(Boolean);
  if (canary.some((c) => c && (fone === c || fone.endsWith(c) || c.endsWith(fone)))) return true;
  if (String(process.env.ELEVEN_FOR_BUSINESS || "").toLowerCase() === "true" && String(user.plano || "").toLowerCase() === "business") return true;
  return false;
}

/**
 * Envia a resposta ao usuário respeitando a preferência:
 * - 'audio' → tenta gerar voz (ElevenLabs premium → Edge → Piper) e enviar como áudio; se falhar, cai p/ texto.
 * - 'texto' ou null → texto.
 * Texto é sempre o padrão seguro (anti-ban).
 */
export async function responder(user: Usuario, phone: string, texto: string): Promise<void> {
  const pref = user.pref_resposta;

  // 'ambos': TEXTO primeiro (resposta percebida instantânea), áudio chega logo atrás.
  if (pref === "ambos") {
    await sendText(phone, texto);
    try {
      const audioB64 = await sintetizar(texto, { premium: vozPremium(user) });
      if (audioB64) await sendAudio(phone, audioB64);
      else log("warn", "tts indisponivel (ambos), texto ja foi", { phone });
    } catch (e) {
      log("warn", "tts erro (ambos), texto ja foi", { e: String(e) });
    }
    return;
  }

  let audioOk = false;
  if (pref === "audio") {
    try {
      const audioB64 = await sintetizar(texto, { premium: vozPremium(user) });
      if (audioB64 && (await sendAudio(phone, audioB64))) audioOk = true;
      else log("warn", "tts indisponivel, caindo p/ texto", { phone });
    } catch (e) {
      log("warn", "tts erro, caindo p/ texto", { e: String(e) });
    }
  }
  // Manda texto quando: preferência é 'texto'/null, OU como fallback se o áudio falhou.
  if (!audioOk) {
    await sendText(phone, texto);
  }
}

const PERGUNTA_PREF =
  `Antes de começarmos 🙂 como você prefere que eu responda?\n` +
  `• *áudio* 🎙️\n` +
  `• *texto* 💬\n` +
  `• *ambos* (áudio + texto)\n\n` +
  `É só responder *áudio*, *texto* ou *ambos* (dá pra mudar depois quando quiser).`;

/** Detecta a escolha de preferência no texto. Retorna 'audio' | 'texto' | 'ambos' | null. */
export function detectarPreferencia(texto: string): "audio" | "texto" | "ambos" | null {
  const t = texto.toLowerCase();
  if (/\b(ambos|os dois|as duas|os 2|tanto faz|qualquer um|qualquer|pode ser os dois|áudio e texto|audio e texto|texto e áudio|texto e audio)\b/.test(t)) return "ambos";
  if (/\b(áudio|audio|voz|por voz|de voz)\b/.test(t)) return "audio";
  if (/\b(texto|escrito|escrita|por escrito|mensagem)\b/.test(t)) return "texto";
  return null;
}

/**
 * Detecta PEDIDO EXPLÍCITO de trocar o formato da resposta, a qualquer momento.
 * Ex.: "responde em áudio", "me manda em voz", "prefiro texto", "pode falar por escrito".
 * Só dispara quando há verbo de pedido + o formato (evita falso positivo).
 */
export async function tentarTrocarPreferencia(user: Usuario, phone: string, texto: string): Promise<boolean> {
  const t = texto.toLowerCase();
  const pediuTroca = /\b(responde|responda|respond|me manda|manda|mande|envia|envie|fala|fale|quero|prefiro|pode ser|muda|mudar|trocar|passa)\b/.test(t);
  if (!pediuTroca) return false;
  const escolha = detectarPreferencia(texto);
  if (!escolha) return false;
  if (user.pref_resposta === escolha) {
    const jaTxt = escolha === "audio" ? "Já estou respondendo por áudio 🎙️"
      : escolha === "ambos" ? "Já estou respondendo por áudio e texto 🎙️💬"
      : "Já estou respondendo por texto 💬";
    await responder(user, phone, jaTxt);
    return true;
  }
  await pool.query(`UPDATE usuarios SET pref_resposta=$1 WHERE id=$2`, [escolha, user.id]);
  user.pref_resposta = escolha;
  const prontoTxt = escolha === "audio" ? "Pronto! 🎙️ Agora respondo por *áudio*. Pode pedir o que precisar 🙂"
    : escolha === "ambos" ? "Pronto! 🎙️💬 Agora respondo por *áudio e texto*. Pode pedir o que precisar 🙂"
    : "Pronto! 💬 Agora respondo por *texto*. Pode pedir o que precisar 🙂";
  await responder(user, phone, prontoTxt);
  return true;
}

/**
 * Gerencia a primeira interação: se o usuário ainda não escolheu preferência,
 * pergunta (ou registra a escolha quando ele responder).
 * Retorna true se "consumiu" a mensagem (já respondeu) — nesse caso o fluxo deve parar.
 */
export async function fluxoPreferencia(user: Usuario, phone: string, texto: string): Promise<boolean> {
  if (user.pref_resposta) return false; // já tem preferência → segue normal

  const escolha = detectarPreferencia(texto);
  if (escolha) {
    await pool.query(`UPDATE usuarios SET pref_resposta=$1, pref_perguntada=true WHERE id=$2`, [escolha, user.id]);
    user.pref_resposta = escolha;
    const confirma =
      escolha === "audio" ? `Perfeito! 🎙️ Vou priorizar *áudio* nas respostas. Pode me pedir o que precisar 🙂`
      : escolha === "ambos" ? `Combinado! 🎙️💬 Vou responder por *áudio e texto*. Pode me pedir o que precisar 🙂`
      : `Combinado! 💬 Vou responder por *texto*. Pode me pedir o que precisar 🙂`;
    await responder(user, phone, confirma);
    return true;
  }

  // Pergunta UMA única vez. Se já perguntou e a pessoa não escolheu, assume 'texto' e segue
  // o fluxo normal (não fica repetindo a pergunta).
  if (user.pref_perguntada) {
    await pool.query(`UPDATE usuarios SET pref_resposta='texto' WHERE id=$1`, [user.id]);
    user.pref_resposta = "texto";
    return false; // não consome → processa a mensagem normalmente
  }
  await sendText(phone, PERGUNTA_PREF);
  await pool.query(`UPDATE usuarios SET pref_perguntada=true WHERE id=$1`, [user.id]);
  return true;
}
