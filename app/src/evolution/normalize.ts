/**
 * Normaliza o payload de webhook da Evolution API (v2) numa estrutura interna.
 *
 * Evento relevante: "messages.upsert".
 * data.key.remoteJid = "5561999999999@s.whatsapp.net" (telefone real)
 * data.message pode ser: conversation | extendedTextMessage | audioMessage | imageMessage ...
 */

export type MsgType = "text" | "audio" | "image" | "document" | "other";

export interface NormalizedMessage {
  instance: string;
  phone: string; // E.164 só dígitos: 5561999999999
  pushName?: string;
  type: MsgType;
  text?: string;
  audioBase64?: string;
  imageBase64?: string;
  imageMime?: string;
  docBase64?: string;
  docFileName?: string;
  fromMe: boolean;
  messageId: string;
  timestamp: number;
}

function jidToPhone(jid: string | undefined): string | null {
  if (!jid) return null;
  if (jid.includes("@g.us")) return null; // grupo — ignora
  const num = jid.split("@")[0]?.split(":")[0]?.replace(/[^\d]/g, "");
  return num && num.length >= 8 ? num : null;
}

export function normalizeEvolution(body: any): NormalizedMessage | null {
  if (!body || typeof body !== "object") return null;
  const event = String(body.event || "").toLowerCase();
  if (event && !event.includes("messages.upsert") && !event.includes("messages_upsert")) return null;

  const instance = String(body.instance || "");
  const data = body.data ?? {};
  const key = data.key ?? {};
  const phone = jidToPhone(key.remoteJid);
  if (!phone) return null;

  const fromMe = Boolean(key.fromMe);
  const messageId = String(key.id || "");
  const timestamp = Number(data.messageTimestamp || Date.now() / 1000);
  const pushName = data.pushName ? String(data.pushName) : undefined;

  const m = data.message ?? {};

  // Texto
  const text: string | undefined =
    (typeof m.conversation === "string" && m.conversation) ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    undefined;

  // Áudio (Evolution manda base64 quando WEBHOOK_BASE64=true)
  const audio = m.audioMessage;
  if (audio) {
    const audioBase64: string | undefined =
      data.message?.base64 || data.base64 || audio.base64 || undefined;
    return { instance, phone, pushName, type: "audio", audioBase64, fromMe, messageId, timestamp };
  }

  if (m.imageMessage) {
    const imageBase64: string | undefined =
      data.message?.base64 || data.base64 || m.imageMessage?.base64 || undefined;
    const imageMime: string | undefined = m.imageMessage?.mimetype || "image/jpeg";
    return { instance, phone, pushName, type: "image", text, imageBase64, imageMime, fromMe, messageId, timestamp };
  }

  // Documento (planilha Excel/CSV, PDF, etc.)
  if (m.documentMessage || m.documentWithCaptionMessage) {
    const doc = m.documentMessage || m.documentWithCaptionMessage?.message?.documentMessage || {};
    const docBase64: string | undefined =
      data.message?.base64 || data.base64 || doc.base64 || undefined;
    const docFileName: string | undefined = doc.fileName || doc.title || undefined;
    return { instance, phone, pushName, type: "document", text, docBase64, docFileName, fromMe, messageId, timestamp };
  }

  if (text) {
    return { instance, phone, pushName, type: "text", text, fromMe, messageId, timestamp };
  }

  return { instance, phone, pushName, type: "other", fromMe, messageId, timestamp };
}
