import axios from "axios";
import { config } from "../config";
import type { ChatMsg } from "./groq";

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";

/** Chat no DeepSeek (raciocínio / conversa / orquestração). */
export async function deepseekChat(
  messages: ChatMsg[],
  opts: { temperature?: number; json?: boolean } = {}
): Promise<string> {
  const body: Record<string, unknown> = {
    model: config.DEEPSEEK_MODEL,
    messages,
    temperature: opts.temperature ?? 0.7,
  };
  if (opts.json) body.response_format = { type: "json_object" };

  const r = await axios.post(DEEPSEEK_URL, body, {
    timeout: 45_000,
    headers: { Authorization: `Bearer ${config.DEEPSEEK_API_KEY}`, "Content-Type": "application/json" },
  });
  return r.data?.choices?.[0]?.message?.content ?? "";
}
