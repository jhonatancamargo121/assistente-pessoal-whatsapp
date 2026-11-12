import { z } from "zod";

const schema = z.object({
  // Servidor
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.string().default("production"),
  APP_TIMEZONE: z.string().default("America/Sao_Paulo"),

  // Banco / cache
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().default("redis://redis:6379"),

  // Evolution API (WhatsApp)
  EVOLUTION_URL: z.string().url(),
  EVOLUTION_API_KEY: z.string().min(1),
  EVOLUTION_INSTANCE: z.string().default("assistente"),

  // Segurança do webhook (Evolution -> app)
  WEBHOOK_SECRET: z.string().min(16),

  // Painel admin
  JWT_SECRET: z.string().min(16),
  COOKIE_SECURE: z.preprocess((v) => v !== "false" && v !== "0", z.boolean()),

  // Criptografia em repouso (AES-256) — 32 bytes em hex (64 chars)
  ENCRYPTION_KEY: z.string().length(64, "ENCRYPTION_KEY deve ter 64 chars hex (32 bytes)"),

  // IA — Groq (tier grátis: intenção, extração, variação)
  GROQ_API_KEY: z.string().min(1),
  GROQ_INTENT_MODEL: z.string().default("llama-3.1-8b-instant"),
  GROQ_CHAT_MODEL: z.string().default("llama-3.3-70b-versatile"),
  GROQ_WHISPER_MODEL: z.string().default("whisper-large-v3"),

  // IA — DeepSeek (raciocínio / conversa)
  DEEPSEEK_API_KEY: z.string().min(1),
  DEEPSEEK_MODEL: z.string().default("deepseek-chat"),

  // Comportamento do assistente
  REENGAJAMENTO_HORAS: z.coerce.number().default(72), // > isso = dormente, segura lembrete
  ANTI_FLOOD_SECONDS: z.coerce.number().default(3),
  CRM_API_URL: z.string().default(""),
  CRM_BOT_EMAIL: z.string().default(""),
  CRM_BOT_SENHA: z.string().default(""),
  CRM_API_KEY: z.string().default(""), // chave de API do CRM (preferida ao login)
});

export const config = schema.parse(process.env);
export type Config = z.infer<typeof schema>;
