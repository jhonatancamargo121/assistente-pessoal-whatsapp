import express, { Request, Response } from "express";
import cookieParser from "cookie-parser";
import path from "path";
import { config } from "./config";
import { log } from "./log";
import { pool } from "./db";
import { normalizeEvolution, type NormalizedMessage } from "./evolution/normalize";
import { sendText, sendTyping } from "./evolution/client";
import { groqTranscribe } from "./ai/groq";
import { classify } from "./ai/intent";
import { handle } from "./core/handlers";
import { checarPendente, precisaConfirmar, prepararConfirmacao } from "./core/confirmacao";
import { intentLiberada, planoNecessario } from "./core/planos";
import { getUsuarioAutorizado, marcarInteracao, registrarMensagem } from "./core/allowlist";
import { getHistorico } from "./core/memoria";
import { isAdmin, tryAdminCommand } from "./core/admin-commands";
import { responder, fluxoPreferencia, tentarTrocarPreferencia } from "./core/reply";
import { processarComprovante, tentarCompletarComprovante } from "./core/comprovante";
import { processarPlanilha, tentarConfirmarPlanilha } from "./core/planilha";
import { processarDocumento } from "./core/documento";
import { getWizard, continuarWizard, iniciarLead, iniciarPagamento, iniciarContrato, receberFotoContrato } from "./core/wizard";
import { startLembretesJob, stopLembretesJob } from "./jobs/lembretes.job";
import { startCrmNotifyJob, stopCrmNotifyJob } from "./jobs/crm-notify.job";
import { startLimpezaJob, stopLimpezaJob } from "./jobs/limpeza.job";
import { startProativoJob, stopProativoJob } from "./jobs/proativo.job";
import { authRouter } from "./routes/auth";
import { adminRouter } from "./routes/admin";

const app = express();
app.use(express.json({ limit: "15mb" }));
app.use(cookieParser());

// Painel admin (API)
app.use("/api/auth", authRouter);
app.use("/api/admin", adminRouter);

// Dedup de webhooks reenviados (Evolution faz retry). TTL evita esquecer um ID
// recém-visto (o clear() total anterior podia reprocessar mensagens).
const vistos = new Map<string, number>(); // messageId -> epoch ms
const VISTO_TTL_MS = 10 * 60 * 1000;
function jaVisto(id: string): boolean {
  if (!id) return false;
  const agora = Date.now();
  if (vistos.size > 5000) {
    for (const [k, t] of vistos) if (agora - t > VISTO_TTL_MS) vistos.delete(k);
  }
  if (vistos.has(id)) return true;
  vistos.set(id, agora);
  return false;
}

// Serialização por usuário: mensagens do MESMO telefone processam em FILA
// (nunca em paralelo). Evita race/duplicação no wizard e em escritas concorrentes.
const filaPorTelefone = new Map<string, Promise<void>>();
function serializarPorUsuario(phone: string, fn: () => Promise<void>): void {
  const anterior = filaPorTelefone.get(phone) || Promise.resolve();
  const atual: Promise<void> = anterior
    .then(() => fn())
    .catch((e) => { log("error", "serial: erro no processamento", { err: String(e) }); });
  filaPorTelefone.set(phone, atual);
  atual.finally(() => {
    // remove a entrada só se ninguém encadeou depois (evita vazar memória)
    if (filaPorTelefone.get(phone) === atual) filaPorTelefone.delete(phone);
  });
}

app.get("/health", (_req, res) => res.json({ ok: true }));

// ── Webhook da Evolution ─────────────────────────────────
app.post("/webhook/evolution", async (req: Request, res: Response) => {
  // Secret via ?token= (Evolution não manda header custom)
  if (String(req.query.token || "") !== config.WEBHOOK_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }
  // Responde rápido; processa em background
  res.status(200).json({ received: true });

  const msg = normalizeEvolution(req.body);
  if (!msg || msg.fromMe) return;
  if (jaVisto(msg.messageId)) return;
  // processa em FILA por telefone (serializado) — nunca dois em paralelo p/ o mesmo user
  serializarPorUsuario(msg.phone, () => processarMensagem(msg));
});

async function processarMensagem(msg: NormalizedMessage): Promise<void> {
  const t0 = Date.now();
  try {
    // 🚪 ALLOWLIST
    const user = await getUsuarioAutorizado(msg.phone);
    if (!user) {
      // registra tentativa de uso por não-assinante (só metadados, p/ relatório de uso indevido)
      try {
        await pool.query(
          `INSERT INTO tentativas_indevidas (phone, tipo) VALUES ($1,$2)`,
          [msg.phone, msg.type || "text"]
        );
      } catch { /* não bloqueia */ }
      log("info", "ignorado: nao autorizado", { phone: msg.phone });
      return;
    }

    // ⌨️ "digitando..." IMEDIATO (inclusive durante transcrição de áudio) — não bloqueia o fluxo.
    sendTyping(msg.phone).catch(() => {});

    // Texto (ou transcrição de áudio)
    let texto = msg.text || "";
    if (msg.type === "audio") {
      if (!msg.audioBase64) {
        await sendText(msg.phone, "Recebi seu áudio, mas não consegui baixá-lo. Pode mandar por texto? 🙏");
        return;
      }
      const t = await groqTranscribe(msg.audioBase64);
      if (!t) {
        await sendText(msg.phone, "Não consegui entender o áudio. Tenta de novo ou manda por texto 🙂");
        return;
      }
      texto = t;
    }

    // 📷 IMAGEM → se há wizard de CONTRATO ativo, é a foto do RG/comprovante; senão, comprovante de gasto
    if (msg.type === "image") {
      await marcarInteracao(user.id);
      await registrarMensagem(user.id, msg.phone, "in", "image", texto || "[imagem]");
      const wzImg = await getWizard(user.id);
      if (wzImg?.tipo === "contrato") {
        await receberFotoContrato(user, msg.phone, wzImg, msg.imageBase64, msg.imageMime);
        log("info", "contrato: foto recebida", { phone: msg.phone, passo: wzImg.passo });
        return;
      }
      await processarComprovante(user, msg.phone, msg.imageBase64, msg.imageMime);
      log("info", "comprovante recebido", { phone: msg.phone });
      return;
    }

    // 📄 DOCUMENTO → planilha (xlsx/csv) configura controle; pdf/docx/txt = comprovante ou resumo
    if (msg.type === "document") {
      await marcarInteracao(user.id);
      await registrarMensagem(user.id, msg.phone, "in", "document", msg.docFileName || "[documento]");
      const e = (msg.docFileName || "").toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || "";
      if (e === "xlsx" || e === "xls" || e === "csv") {
        await processarPlanilha(user, msg.phone, msg.docBase64, msg.docFileName);
        log("info", "planilha recebida", { phone: msg.phone });
      } else {
        await processarDocumento(user, msg.phone, msg.docBase64, msg.docFileName);
        log("info", "documento recebido", { phone: msg.phone, ext: e });
      }
      return;
    }

    if (!texto.trim()) return;

    await marcarInteracao(user.id);
    // 🧠 Memória por usuário: histórico recente ANTES de gravar a mensagem atual.
    const historico = await getHistorico(user.id, 10);
    await registrarMensagem(user.id, msg.phone, "in", msg.type, texto);

    // 👍👎 Feedback rápido sobre a última resposta (vai pro painel de qualidade)
    if (/^(👍|👎|curti|gostei|muito bom|ótimo|otimo|top|ruim|não gostei|nao gostei|péssimo|pessimo)\s*[!.]*$/i.test(texto.trim())) {
      const voto = /👍|curti|gostei|bom|ótimo|otimo|top/i.test(texto) ? "positivo" : "negativo";
      const ctx = await pool.query(`SELECT conteudo FROM mensagens WHERE user_id=$1 AND direcao='out' ORDER BY created_at DESC LIMIT 1`, [user.id]);
      await pool.query(`INSERT INTO feedbacks (user_id, voto, contexto) VALUES ($1,$2,$3)`, [user.id, voto, ctx.rows[0]?.conteudo?.slice(0, 500) || null]);
      const resp = voto === "positivo" ? "Valeu! 🙌 Fico feliz que ajudou." : "Poxa, anotei aqui pra melhorar 🙏 Se quiser, me diz o que saiu errado.";
      await sendText(msg.phone, resp);
      await registrarMensagem(user.id, msg.phone, "out", "text", resp, "feedback", "template");
      return;
    }

    // 🔐 LGPD: confirmação de exclusão total (frase exata, deterministico)
    if (texto.trim() === "APAGAR TUDO") {
      for (const tab of ["tarefas", "rotinas", "lancamentos", "habito_checkins", "habitos", "categorias_usuario", "contas_fixas", "lista_itens", "mensagens", "lembretes_enviados", "pendencias_reengajamento", "gastos_pendentes"]) {
        try { await pool.query(`DELETE FROM ${tab} WHERE user_id=$1`, [user.id]); } catch { /* tabela pode não ter user_id */ }
      }
      await pool.query(`UPDATE usuarios SET pending_acao=NULL, wizard_state=NULL, resumo_diario=false, resumo_semanal=false WHERE id=$1`, [user.id]);
      await sendText(msg.phone, "🗑️ Pronto. Todos os seus dados foram apagados (tarefas, finanças, rotinas, hábitos, listas e histórico). Sua assinatura segue ativa — se quiser recomeçar, é só me mandar uma mensagem 🙂");
      log("info", "lgpd: dados apagados a pedido", { phone: msg.phone });
      return;
    }

    // 🛠️ Comandos de ADMIN (só para número admin). Se for comando, responde e encerra.
    if (isAdmin(user)) {
      const adminResp = await tryAdminCommand(texto);
      if (adminResp) {
        await sendText(msg.phone, adminResp);
        await registrarMensagem(user.id, msg.phone, "out", "text", adminResp, "admin", "template");
        log("info", "comando admin", { phone: msg.phone });
        return;
      }
    }

    // 🎙️ Primeira interação: pergunta/define preferência (áudio ou texto)
    if (await fluxoPreferencia(user, msg.phone, texto)) {
      log("info", "fluxo de preferencia", { phone: msg.phone, pref: user.pref_resposta });
      return;
    }

    // 🔄 Troca de formato a qualquer momento ("responde em áudio", "prefiro texto")
    if (await tentarTrocarPreferencia(user, msg.phone, texto)) {
      log("info", "trocou preferencia", { phone: msg.phone, pref: user.pref_resposta });
      return;
    }

    // 📊 Se há uma planilha aguardando confirmação, esta msg é o sim/não
    if (await tentarConfirmarPlanilha(user, msg.phone, texto)) {
      log("info", "planilha confirmada/cancelada", { phone: msg.phone });
      return;
    }

    // 📷 Se há um comprovante aguardando categoria, esta msg é a categoria
    if (await tentarCompletarComprovante(user, msg.phone, texto)) {
      log("info", "comprovante completado", { phone: msg.phone });
      return;
    }

    // 🧙 Wizard ativo (criar lead / pagamento passo a passo)? Esta msg é a resposta do passo.
    const wz = await getWizard(user.id);
    if (wz) {
      const r = await continuarWizard(user, wz, texto);
      await responder(user, msg.phone, r.reply);
      await registrarMensagem(user.id, msg.phone, "out", "text", r.reply, `wizard_${wz.tipo}`, "template");
      log("info", "wizard passo", { phone: msg.phone, tipo: wz.tipo, done: r.done });
      return;
    }

    // Entrega pendências de reengajamento (lembretes segurados)
    const pend = await pool.query(
      `UPDATE pendencias_reengajamento SET entregue_em=now()
        WHERE id IN (SELECT id FROM pendencias_reengajamento WHERE user_id=$1 AND entregue_em IS NULL ORDER BY created_at LIMIT 5)
       RETURNING texto`,
      [user.id]
    );
    for (const p of pend.rows) await sendText(msg.phone, `⏰ ${p.texto}`);

    await sendTyping(msg.phone);

    // ✅ Confirmação pendente? (ação crítica aguardando sim/não)
    const pendente = await checarPendente(user, texto);
    if (pendente.tratou && pendente.result) {
      await responder(user, msg.phone, pendente.result.reply);
      await registrarMensagem(user.id, msg.phone, "out", "text", pendente.result.reply, "confirmacao", pendente.result.provider);
      log("info", "respondido", { phone: msg.phone, intent: "confirmacao" });
      return;
    }

    // 🧠 Intenção → (gate por plano) → (confirmar se crítico) → handler
    const tClass = Date.now();
    const intent = await classify(texto, user.timezone, historico);
    const msClassify = Date.now() - tClass;

    // 🔒 Gate por plano: skill não inclusa no plano do assinante → upsell
    if (!intentLiberada(user.plano, intent.intent)) {
      const planoNec = planoNecessario(intent.intent);
      const aviso = `Esse recurso está no plano *${planoNec}*. Fale com o administrador pra liberar 🙂`;
      await responder(user, msg.phone, aviso);
      await registrarMensagem(user.id, msg.phone, "out", "text", aviso, intent.intent + "_bloqueado", "template");
      log("info", "skill bloqueada por plano", { phone: msg.phone, intent: intent.intent, plano: user.plano });
      return;
    }

    // 🧙 Inicia wizard de criar lead / registrar pagamento (passo a passo) p/ quem tem CRM.
    if ((intent.intent === "criar_lead" || intent.intent === "registrar_pagamento") && user.crm_email) {
      const pergunta = intent.intent === "criar_lead" ? await iniciarLead(user, intent) : await iniciarPagamento(user, intent);
      await responder(user, msg.phone, pergunta);
      await registrarMensagem(user.id, msg.phone, "out", "text", pergunta, `wizard_${intent.intent}_start`, "template");
      log("info", "wizard iniciado", { phone: msg.phone, intent: intent.intent });
      return;
    }

    // 📄 Inicia wizard de CONTRATO (corretor com CRM ativo, ou admin)
    if (intent.intent === "preencher_contrato") {
      if (!(isAdmin(user) || Boolean(user.crm_email))) {
        const aviso = "📄 A geração de contratos é um recurso pra corretores com CRM ativo. Fale com o administrador pra liberar 🙂";
        await responder(user, msg.phone, aviso);
        await registrarMensagem(user.id, msg.phone, "out", "text", aviso, "preencher_contrato_bloqueado", "template");
        return;
      }
      const pergunta = await iniciarContrato(user);
      await responder(user, msg.phone, pergunta);
      await registrarMensagem(user.id, msg.phone, "out", "text", pergunta, "wizard_contrato_start", "template");
      log("info", "wizard contrato iniciado", { phone: msg.phone });
      return;
    }

    if (precisaConfirmar(intent)) {
      const pergunta = await prepararConfirmacao(user, intent);
      await responder(user, msg.phone, pergunta);
      await registrarMensagem(user.id, msg.phone, "out", "text", pergunta, intent.intent + "_confirmar", "template");
      log("info", "confirmacao solicitada", { phone: msg.phone, intent: intent.intent });
      return;
    }

    const tHandle = Date.now();
    const out = await handle(intent, user, texto, historico);
    const msHandle = Date.now() - tHandle;
    await responder(user, msg.phone, out.reply);
    await registrarMensagem(user.id, msg.phone, "out", "text", out.reply, intent.intent, out.provider);
    // 📊 Telemetria de latência por etapa (P6): achar gargalo sem adivinhar.
    log("info", "respondido", {
      phone: msg.phone, intent: intent.intent, provider: out.provider, pref: user.pref_resposta,
      ms_classify: msClassify, ms_handle: msHandle, ms_total: Date.now() - t0,
    });
  } catch (err) {
    log("error", "webhook: erro no processamento", { err: String(err) });
  }
}

// Painel admin (frontend estático)
const PUBLIC_DIR = path.join(__dirname, "..", "public");
app.use(express.static(PUBLIC_DIR));
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api") || req.path.startsWith("/webhook")) return next();
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

const server = app.listen(config.PORT, () => {
  log("info", `assistente-pessoal ouvindo em :${config.PORT}`, {
    env: config.NODE_ENV,
    instance: config.EVOLUTION_INSTANCE,
  });
  startLembretesJob();
  startCrmNotifyJob();
  startLimpezaJob();
  startProativoJob();
});

// Shutdown gracioso
let encerrando = false;
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    if (encerrando) return;
    encerrando = true;
    log("info", `${sig} recebido, encerrando...`);
    stopLembretesJob();
    stopCrmNotifyJob();
    stopLimpezaJob();
    stopProativoJob();
    // força saída se o close pendurar (conexão aberta)
    const forcar = setTimeout(() => process.exit(0), 8000);
    server.close(() => {
      clearTimeout(forcar);
      pool.end().finally(() => process.exit(0));
    });
  });
}
