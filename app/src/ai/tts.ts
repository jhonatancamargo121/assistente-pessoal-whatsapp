import { spawn } from "child_process";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { log } from "../log";
import { sintetizarEleven, elevenLabsConfigurado } from "./elevenlabs";

/**
 * TTS com cascata de motores (todos retornam OGG/Opus base64):
 *   0) ElevenLabs (PREMIUM, voz humana) — só quando opts.premium=true e a chave existe
 *   1) Edge TTS (Microsoft, voz neural natural) via CLI `edge-tts` (Python) — PADRÃO grátis
 *   2) Piper (offline, local) — FALLBACK automático
 *
 * Env:
 *   EDGE_TTS_VOICE  (default: pt-BR-FranciscaNeural)
 *   TTS_ENGINE      ("edge" | "piper" | "auto"=default)
 *   PIPER_BIN, PIPER_MODEL
 */
const EDGE_VOICE = process.env.EDGE_TTS_VOICE || "pt-BR-FranciscaNeural";
const TTS_ENGINE = (process.env.TTS_ENGINE || "auto").toLowerCase();
const PIPER_BIN = process.env.PIPER_BIN || "piper";
const PIPER_MODEL = process.env.PIPER_MODEL || "";

let avisadoPiper = false;

function limpar(texto: string): string {
  return texto
    // remove EMOJIS e símbolos pictográficos (no áudio não devem ser narrados)
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{1F1E6}-\u{1F1FF}\u{FE00}-\u{FE0F}\u{200D}]/gu, "")
    // remove markdown
    .replace(/[*_~`#>]/g, "")
    // colapsa espaços que sobraram
    .replace(/\s{2,}/g, " ")
    .slice(0, 700)
    .trim();
}

function run(cmd: string, args: string[], stdin?: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    p.stdout.on("data", (d) => out.push(d));
    p.stderr.on("data", (d) => err.push(d));
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`${cmd} saiu ${code}: ${Buffer.concat(err).toString().slice(0, 200)}`))
    );
    if (stdin) p.stdin.write(stdin);
    p.stdin.end();
  });
}

// ───────────────────────── Edge TTS (CLI Python) ─────────────────────────
async function sintetizarEdge(texto: string): Promise<string | null> {
  const clean = limpar(texto);
  if (!clean) return null;
  const mp3 = path.join(os.tmpdir(), `edge_${Date.now()}.mp3`);
  try {
    await run("edge-tts", ["--voice", EDGE_VOICE, "--text", clean, "--write-media", mp3]);
    const st = await fs.stat(mp3).catch(() => null);
    if (!st || st.size < 200) return null;
    const ogg = await run("ffmpeg", ["-y", "-i", mp3, "-c:a", "libopus", "-b:a", "32k", "-vbr", "on", "-application", "voip", "-ar", "16000", "-f", "ogg", "pipe:1", "-loglevel", "error"]);
    return ogg.toString("base64");
  } catch (e) {
    log("warn", "edge-tts falhou", { e: String(e) });
    return null;
  } finally {
    fs.unlink(mp3).catch(() => {});
  }
}

// ───────────────────────── Piper (offline) ─────────────────────────
async function sintetizarPiper(texto: string): Promise<string | null> {
  if (!PIPER_MODEL) {
    if (!avisadoPiper) { log("info", "Piper desligado: defina PIPER_MODEL"); avisadoPiper = true; }
    return null;
  }
  const tmp = path.join(os.tmpdir(), `piper_${Date.now()}.wav`);
  try {
    await run(PIPER_BIN, ["--model", PIPER_MODEL, "--output_file", tmp], Buffer.from(limpar(texto), "utf-8"));
    const ogg = await run("ffmpeg", ["-y", "-i", tmp, "-c:a", "libopus", "-b:a", "32k", "-f", "ogg", "pipe:1", "-loglevel", "error"]);
    return ogg.toString("base64");
  } catch (e) {
    log("warn", "Piper sintetizar falhou", { e: String(e) });
    return null;
  } finally {
    fs.unlink(tmp).catch(() => {});
  }
}

// ───────────────────────── API pública ─────────────────────────
/**
 * Sintetiza texto em áudio (OGG/Opus base64), ou null se nenhum motor disponível.
 * opts.premium: tenta ElevenLabs primeiro (voz humana); se falhar, cai p/ Edge → Piper.
 * auto: tenta Edge (voz melhor); se falhar, cai no Piper.
 */
export async function sintetizar(texto: string, opts: { premium?: boolean } = {}): Promise<string | null> {
  // 0) Premium (ElevenLabs) — só quando habilitado p/ este usuário e a chave existe.
  if (opts.premium && elevenLabsConfigurado()) {
    const el = await sintetizarEleven(texto);
    if (el) return el;
    log("info", "elevenlabs indisponivel, caindo p/ edge/piper");
  }
  if (TTS_ENGINE === "piper") return sintetizarPiper(texto);
  if (TTS_ENGINE === "edge") return sintetizarEdge(texto);
  // auto
  const edge = await sintetizarEdge(texto);
  if (edge) return edge;
  log("info", "edge indisponivel, usando Piper (fallback)");
  return sintetizarPiper(texto);
}
