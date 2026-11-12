import axios from "axios";
import { config } from "../config";

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

export interface ChatMsg {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Chamada de chat no Groq (tier grátis). Lança em erro p/ permitir fallback. */
export async function groqChat(
  messages: ChatMsg[],
  opts: { model?: string; json?: boolean; temperature?: number } = {}
): Promise<string> {
  const body: any = {
    model: opts.model || config.GROQ_CHAT_MODEL,
    messages,
    temperature: opts.temperature ?? 0.4,
  };
  if (opts.json) body.response_format = { type: "json_object" };

  const r = await axios.post(GROQ_URL, body, {
    timeout: 30_000,
    headers: { Authorization: `Bearer ${config.GROQ_API_KEY}`, "Content-Type": "application/json" },
  });
  return r.data?.choices?.[0]?.message?.content ?? "";
}

/** Transcreve áudio (base64) via Whisper no Groq. */
export async function groqTranscribe(audioBase64: string): Promise<string | null> {
  try {
    const buf = Buffer.from(audioBase64, "base64");
    const form = new FormData();
    const blob = new Blob([buf], { type: "audio/ogg" });
    form.append("file", blob, "audio.ogg");
    form.append("model", config.GROQ_WHISPER_MODEL);
    form.append("language", "pt");

    const r = await axios.post("https://api.groq.com/openai/v1/audio/transcriptions", form, {
      timeout: 60_000,
      headers: { Authorization: `Bearer ${config.GROQ_API_KEY}` },
    });
    return r.data?.text ?? null;
  } catch {
    return null;
  }
}
