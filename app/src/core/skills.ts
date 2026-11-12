import axios from "axios";
import { log } from "../log";

/** 🌤️ Clima via wttr.in (grátis, sem chave). */
export async function clima(cidade?: string | null): Promise<string> {
  const cic = (cidade || "").trim() || "Brasília";
  try {
    const r = await axios.get(`https://wttr.in/${encodeURIComponent(cic)}?format=j1&lang=pt`, {
      timeout: 12_000,
      headers: { "Accept-Language": "pt-BR", "User-Agent": "curl/8" },
    });
    const cur = r.data?.current_condition?.[0];
    const hoje = r.data?.weather?.[0];
    if (!cur) return `Não achei o clima de *${cic}* 😕 Tenta o nome da cidade + estado.`;
    const desc = cur.lang_pt?.[0]?.value || cur.weatherDesc?.[0]?.value || "";
    return (
      `🌤️ *${cic}* agora: ${cur.temp_C}°C, ${desc}.\n` +
      `Sensação ${cur.FeelsLikeC}°C · umidade ${cur.humidity}%.\n` +
      `Hoje: máx ${hoje?.maxtempC}°C / mín ${hoje?.mintempC}°C.`
    );
  } catch (e) {
    log("warn", "skill clima falhou", { cic, e: String(e) });
    return "Não consegui consultar o clima agora 😕 Tenta de novo em instantes.";
  }
}

/** 💱 Cotações (grátis, sem chave): open.er-api (câmbio) + coinbase (bitcoin). */
export async function cotacao(): Promise<string> {
  const n = (v: number, dec = 2) => Number(v).toLocaleString("pt-BR", { minimumFractionDigits: dec, maximumFractionDigits: dec });
  try {
    const fx = await axios.get("https://open.er-api.com/v6/latest/USD", { timeout: 12_000 });
    const rates = fx.data?.rates;
    if (!rates?.BRL) throw new Error("sem cotacao");
    const usd = rates.BRL;
    const eur = rates.EUR ? rates.BRL / rates.EUR : null;
    let btc: number | null = null;
    try {
      const b = await axios.get("https://api.coinbase.com/v2/prices/BTC-BRL/spot", { timeout: 8_000 });
      btc = Number(b.data?.data?.amount) || null;
    } catch { /* bitcoin opcional */ }

    let out = `💱 *Cotações agora:*\n💵 Dólar: R$ ${n(usd)}`;
    if (eur) out += `\n💶 Euro: R$ ${n(eur)}`;
    if (btc) out += `\n₿ Bitcoin: R$ ${n(btc, 0)}`;
    return out;
  } catch (e) {
    log("warn", "skill cotacao falhou", { e: String(e) });
    return "Não consegui consultar as cotações agora 😕 Tenta de novo em instantes.";
  }
}
