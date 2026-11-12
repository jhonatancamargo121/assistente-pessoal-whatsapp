import crypto from "crypto";
import { config } from "./config";

/**
 * Criptografia em repouso (AES-256-GCM) para dados sensíveis no banco.
 * Formato armazenado:  enc:v1:<iv_b64>:<tag_b64>:<ciphertext_b64>
 *
 * - Chave: ENCRYPTION_KEY (32 bytes em hex no .env).
 * - GCM garante confidencialidade + integridade (detecta adulteração).
 * - enc(): cifra um texto. dec(): decifra; se o valor não estiver no formato
 *   cifrado (dados antigos em texto puro), retorna como está (retrocompatível).
 */

const PREFIX = "enc:v1:";

function getKey(): Buffer {
  const hex = (config as any).ENCRYPTION_KEY as string;
  return Buffer.from(hex, "hex"); // 32 bytes
}

/** Cifra um texto. Retorna null se a entrada for null/undefined. */
export function enc(plain: string | null | undefined): string | null {
  if (plain == null) return null;
  const s = String(plain);
  if (s === "") return "";
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
  const ct = Buffer.concat([cipher.update(s, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + iv.toString("base64") + ":" + tag.toString("base64") + ":" + ct.toString("base64");
}

/** Decifra. Se não estiver no formato cifrado (legado em texto puro), devolve igual. */
export function dec(stored: string | null | undefined): string | null {
  if (stored == null) return null;
  const s = String(stored);
  if (!s.startsWith(PREFIX)) return s; // legado / texto puro
  try {
    const [, , ivB64, tagB64, ctB64] = s.split(":");
    const iv = Buffer.from(ivB64, "base64");
    const tag = Buffer.from(tagB64, "base64");
    const ct = Buffer.from(ctB64, "base64");
    const decipher = crypto.createDecipheriv("aes-256-gcm", getKey(), iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString("utf8");
  } catch {
    return s; // se falhar, não quebra o fluxo
  }
}

/** True se o valor já está cifrado. */
export function isEnc(s: string | null | undefined): boolean {
  return typeof s === "string" && s.startsWith(PREFIX);
}
