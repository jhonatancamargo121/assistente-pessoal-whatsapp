import { spawn } from "child_process";
import { log } from "../log";

/**
 * TTS PREMIUM via ElevenLabs (voz natural "humana").
 * Retorna OGG/Opus base64 (formato de áudio do WhatsApp), ou null se indisponível.
 *
 * Env:
 *   ELEVENLABS_API_KEY   (obrigatória p/ ativar)
 *   ELEVENLABS_VOICE_ID  (default: Bella — EXAVITQu4vr4xnSDxMaL)
 *   ELEVENLABS_MODEL     (default: eleven_multilingual_v2 — melhor p/ PT)
 */
const API_KEY = process.env.ELEVENLABS_API_KEY || "";
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "EXAVITQu4vr4xnSDxMaL"; // Bella
const MODEL = process.env.ELEVENLABS_MODEL || "eleven_multilingual_v2";

export function elevenLabsConfigurado(): boolean {
  return Boolean(API_KEY);
}

function limpar(texto: string): string {
  return texto
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{1F1E6}-\u{1F1FF}\u{FE00}-\u{FE0F}\u{200D}]/gu, "")
    .replace(/[*_~`#>]/g, "")
    .replace(/\s{2,}/g, " ")
    .slice(0, 800)
    .trim();
}

/** Converte MP3 (buffer) em OGG/Opus (buffer) via ffmpeg, no formato do WhatsApp. */
function mp3ParaOgg(mp3: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const args = ["-y", "-i", "pipe:0", "-c:a", "libopus", "-b:a", "32k", "-vbr", "on", "-application", "voip", "-ar", "16000", "-f", "ogg", "pipe:1", "-loglevel", "error"];
    const p = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    p.stdout.on("data", (d) => out.push(d));
    p.stderr.on("data", (d) => err.push(d));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error("ffmpeg " + code + ": " + Buffer.concat(err).toString().slice(0, 200)))));
    p.stdin.write(mp3);
    p.stdin.end();
  });
}

export async function sintetizarEleven(texto: string): Promise<string | null> {
  if (!API_KEY) return null;
  const clean = limpar(texto);
  if (!clean) return null;
  try {
    const url = `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=mp3_44100_128`;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "xi-api-key": API_KEY,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text: clean,
        model_id: MODEL,
        voice_settings: { stability: 0.5, similarity_boost: 0.8, style: 0.35, use_speaker_boost: true },
      }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      log("warn", "elevenlabs falhou", { status: resp.status, body: body.slice(0, 200) });
      return null;
    }
    const mp3 = Buffer.from(await resp.arrayBuffer());
    if (mp3.length < 200) return null;
    const ogg = await mp3ParaOgg(mp3);
    return ogg.toString("base64");
  } catch (e) {
    log("warn", "elevenlabs erro", { e: String(e) });
    return null;
  }
}
