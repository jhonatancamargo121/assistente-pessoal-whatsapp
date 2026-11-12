import axios, { AxiosInstance } from "axios";
import { config } from "../config";
import { log } from "../log";

const http: AxiosInstance = axios.create({
  baseURL: config.EVOLUTION_URL.replace(/\/+$/, ""),
  timeout: 30_000,
  headers: { "Content-Type": "application/json", apikey: config.EVOLUTION_API_KEY },
});

const inst = encodeURIComponent(config.EVOLUTION_INSTANCE);

/** Envia texto simples para um número (E.164 só dígitos). */
export async function sendText(phone: string, text: string): Promise<boolean> {
  try {
    await http.post(`/message/sendText/${inst}`, { number: phone, text });
    return true;
  } catch (err: any) {
    log("warn", "evolution: sendText falhou", { phone, err: err?.response?.data || String(err) });
    return false;
  }
}

/** Envia áudio de voz (PTT) a partir de um base64 (ogg/opus). */
export async function sendAudio(phone: string, audioBase64: string): Promise<boolean> {
  try {
    await http.post(`/message/sendWhatsAppAudio/${inst}`, { number: phone, audio: audioBase64 });
    return true;
  } catch (err: any) {
    log("warn", "evolution: sendAudio falhou", { phone, err: err?.response?.data || String(err) });
    return false;
  }
}

/** Envia um DOCUMENTO (base64) — ex: relatório .xlsx. */
export async function sendDocument(phone: string, base64: string, fileName: string, caption?: string, mimetype?: string): Promise<boolean> {
  try {
    await http.post(`/message/sendMedia/${inst}`, {
      number: phone,
      mediatype: "document",
      mimetype: mimetype || "application/octet-stream",
      media: base64,
      fileName,
      caption: caption || "",
    });
    return true;
  } catch (err: any) {
    log("warn", "evolution: sendDocument falhou", { phone, err: err?.response?.data || String(err) });
    return false;
  }
}

/** Mostra "digitando..." (presença). Best-effort. */
export async function sendTyping(phone: string, ms = 1200): Promise<void> {
  try {
    await http.post(`/chat/sendPresence/${inst}`, { number: phone, presence: "composing", delay: ms });
  } catch {
    /* ignore */
  }
}

/** Status da instância (connected/connecting/close). */
export async function instanceStatus(): Promise<any> {
  try {
    const r = await http.get(`/instance/connectionState/${inst}`);
    return r.data;
  } catch (err: any) {
    log("warn", "evolution: status falhou", { err: String(err) });
    return null;
  }
}

/** Retorna o QR (base64) para conectar a instância. */
export async function instanceConnect(): Promise<any> {
  try {
    const r = await http.get(`/instance/connect/${inst}`);
    return r.data;
  } catch (err: any) {
    log("warn", "evolution: connect falhou", { err: String(err) });
    return null;
  }
}
