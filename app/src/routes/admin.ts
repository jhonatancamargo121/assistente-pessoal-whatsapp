import { Router } from "express";
import { pool } from "../db";
import { adminRequired } from "../auth/middleware";
import { instanceStatus, instanceConnect, sendText } from "../evolution/client";
import { enviarBoasVindas } from "../core/welcome";
import { canonicalPhone, acharUsuarioPorVariante } from "../core/allowlist";
import { statusCRM } from "../core/crm";
import { dec } from "../crypto";

export const adminRouter = Router();
adminRouter.use(adminRequired);

// Validade padrão de uma nova assinatura (dias)
const VALIDADE_PADRAO_DIAS = 30;

// ── Dashboard ──────────────────────────────────────────────
adminRouter.get("/stats", async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM usuarios WHERE status='ativo')        AS ativos,
      (SELECT COUNT(*) FROM usuarios)                             AS total,
      (SELECT COUNT(*) FROM tarefas WHERE status='pendente')     AS tarefas_pendentes,
      (SELECT COUNT(*) FROM mensagens WHERE created_at > now() - interval '24 hours') AS msgs_24h
  `);
  return res.json(rows[0]);
});

// ── Integração CRM (status da API) ─────────────────────────
adminRouter.get("/crm/status", async (_req, res) => {
  try {
    const st = await statusCRM();
    return res.json(st);
  } catch (e: any) {
    return res.json({ ok: false, modo: "off", erro: String(e?.message || e).slice(0, 120) });
  }
});

// ── Usuários (contatos + assinaturas) ─────────────────────
adminRouter.get("/usuarios", async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT id, phone, nome, status, plano, assinatura_ate, welcome_enviada, crm_ativo, crm_email, last_interaction_at, created_at,
            CASE
              WHEN assinatura_ate IS NULL THEN 'sem_vencimento'
              WHEN assinatura_ate >= current_date THEN 'em_dia'
              ELSE 'vencido'
            END AS pagamento
       FROM usuarios ORDER BY created_at DESC LIMIT 500`
  );
  return res.json({ usuarios: rows });
});

adminRouter.post("/usuarios", async (req, res) => {
  const raw = String(req.body?.phone || "").replace(/[^\d]/g, "");
  if (raw.length < 10) return res.status(400).json({ error: "telefone_invalido", mensagem: "Telefone com DDI+DDD (ex: 5561999998888)." });
  // Normaliza para a forma canônica (BR sempre COM o 9) — evita conta duplicada pelo 9º dígito.
  const phone = canonicalPhone(raw);
  const nome = String(req.body?.nome || "").trim() || null;
  const plano = String(req.body?.plano || "free");
  // Validade: usa a data informada OU, se vazia, hoje + 30 dias (validade padrão)
  let assinatura_ate = req.body?.assinatura_ate || null;
  if (!assinatura_ate) {
    const d = new Date();
    d.setDate(d.getDate() + VALIDADE_PADRAO_DIAS);
    assinatura_ate = d.toISOString().slice(0, 10);
  }

  // 🛡️ Impede DUPLICIDADE pelo 9º dígito: se qualquer variante do número já existe,
  // não cria outra conta — orienta a EDITAR a existente (ex: pra dar acesso ao CRM).
  const existente = await acharUsuarioPorVariante(phone);
  if (existente) {
    return res.status(409).json({
      error: "ja_existe",
      id: existente.id,
      mensagem: `Esse número já está cadastrado como "${existente.nome || existente.phone}". Edite esse usuário (acesso ao CRM, plano, etc.) em vez de criar outro — assim cada pessoa fica numa conta só.`,
    });
  }

  try {
    const status = String(req.body?.status || "ativo");
    const { rows } = await pool.query(
      `INSERT INTO usuarios (phone, nome, plano, assinatura_ate, status)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [phone, nome, plano, assinatura_ate, status]
    );
    const u = rows[0];
    // Boas-vindas (default: enviar, se ativo e WhatsApp conectado)
    let boas_vindas = "nao_enviada";
    const enviar = req.body?.enviar_boas_vindas !== false;
    if (enviar && u.status === "ativo") {
      const ok = await enviarBoasVindas(u.id, u.phone, u.nome);
      boas_vindas = ok ? "enviada" : "falhou_whatsapp";
    }
    return res.status(201).json({ usuario: u, boas_vindas });
  } catch (e: any) {
    if (String(e?.code) === "23505") return res.status(409).json({ error: "ja_existe", mensagem: "Esse telefone já está cadastrado." });
    return res.status(500).json({ error: "falha", mensagem: String(e?.message || e).slice(0, 200) });
  }
});

adminRouter.patch("/usuarios/:id", async (req, res) => {
  const campos: string[] = [];
  const vals: any[] = [];
  let i = 1;
  for (const k of ["nome", "status", "plano", "assinatura_ate", "timezone", "crm_ativo", "crm_email"]) {
    if (k in req.body) { campos.push(`${k}=$${i++}`); vals.push(req.body[k] === "" ? null : req.body[k]); }
  }
  if (campos.length === 0) return res.status(400).json({ error: "nada_para_atualizar" });
  // estado ANTES (p/ detectar liberacao de CRM agora)
  const antes = await pool.query(`SELECT phone, nome, crm_email, crm_ativo FROM usuarios WHERE id=$1`, [req.params.id]);
  vals.push(req.params.id);
  const { rows } = await pool.query(`UPDATE usuarios SET ${campos.join(", ")} WHERE id=$${i} RETURNING *`, vals);
  if (!rows[0]) return res.status(404).json({ error: "nao_encontrado" });
  // 📄 CRM liberado AGORA → pede o contrato de intermediacao (fire-and-forget)
  const tinhaCrm = Boolean(antes.rows[0]?.crm_email) || Boolean(antes.rows[0]?.crm_ativo);
  const temCrm = Boolean(rows[0].crm_email) || Boolean(rows[0].crm_ativo);
  if (!tinhaCrm && temCrm && rows[0].phone) {
    const nome = String(rows[0].nome || "").split(" ")[0];
    const avisoContratoCRM =
      `🏢 *${nome ? nome + ", s" : "S"}eu acesso ao CRM foi liberado!* 🎉\n\n` +
      `Agora você gerencia leads, pagamentos, visitas e contratos direto por aqui — manda *ajuda* pra ver tudo.\n\n` +
      `📄 *Passo importante:* envie o seu *Contrato de Intermediação* (PDF com seus dados e CRECI) no painel:\n` +
      `painel.natela.exemplo.com → *Configurações* → *Contrato de Intermediação*\n\n` +
      `É com ele que eu preencho automaticamente os contratos dos seus clientes — depois é só me pedir _"preenche um contrato"_ 😉`;
    sendText(rows[0].phone, avisoContratoCRM).catch(() => {});
  }
  return res.json({ usuario: rows[0] });
});

adminRouter.delete("/usuarios/:id", async (req, res) => {
  await pool.query(`DELETE FROM usuarios WHERE id=$1`, [req.params.id]);
  return res.json({ ok: true });
});

// Histórico de mensagens de um usuário
adminRouter.get("/usuarios/:id/mensagens", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT direcao, tipo, conteudo, intent, provider, created_at
       FROM mensagens WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100`,
    [req.params.id]
  );
  for (const r of rows) r.conteudo = dec(r.conteudo); // decifra p/ exibir no painel
  return res.json({ mensagens: rows });
});

// Reenviar boas-vindas manualmente
adminRouter.post("/usuarios/:id/boas-vindas", async (req, res) => {
  const { rows } = await pool.query(`SELECT id, phone, nome FROM usuarios WHERE id=$1`, [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: "nao_encontrado" });
  const ok = await enviarBoasVindas(rows[0].id, rows[0].phone, rows[0].nome, true);
  return res.json({ ok, mensagem: ok ? "Boas-vindas enviada! ✅" : "Falhou — o WhatsApp está conectado?" });
});

// Mapa de períodos de assinatura → dias
const PERIODOS: Record<string, number> = { mensal: 30, trimestral: 90, semestral: 180, anual: 365 };

// Renovar assinatura (+período ou +dias) e reativar
adminRouter.post("/usuarios/:id/renovar", async (req, res) => {
  const periodo = String(req.body?.periodo || "").toLowerCase();
  const dias = PERIODOS[periodo] || Number(req.body?.dias) || 30;
  const { rows } = await pool.query(
    `UPDATE usuarios
        SET assinatura_ate = (GREATEST(COALESCE(assinatura_ate, current_date), current_date) + make_interval(days => $2))::date,
            status = 'ativo'
      WHERE id=$1
      RETURNING assinatura_ate`,
    [req.params.id, dias]
  );
  if (!rows[0]) return res.status(404).json({ error: "nao_encontrado" });
  return res.json({ ok: true, assinatura_ate: rows[0].assinatura_ate });
});

// Ativar / desativar (toggle de status)
adminRouter.post("/usuarios/:id/toggle", async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE usuarios SET status = CASE WHEN status='ativo' THEN 'suspenso' ELSE 'ativo' END
      WHERE id=$1 RETURNING status`,
    [req.params.id]
  );
  if (!rows[0]) return res.status(404).json({ error: "nao_encontrado" });
  return res.json({ ok: true, status: rows[0].status });
});

// ── Conexão WhatsApp (Evolution) ──────────────────────────
adminRouter.get("/whatsapp/status", async (_req, res) => {
  const st = await instanceStatus();
  return res.json(st || { error: "indisponivel" });
});

adminRouter.get("/whatsapp/qr", async (_req, res) => {
  const data = await instanceConnect();
  return res.json(data || { error: "indisponivel" });
});

// ── Backfill: aplica validade padrão a quem está SEM data ──
adminRouter.post("/usuarios/preencher-validade", async (req, res) => {
  const dias = Number(req.body?.dias) || VALIDADE_PADRAO_DIAS;
  const { rowCount } = await pool.query(
    `UPDATE usuarios
        SET assinatura_ate = (current_date + make_interval(days => $1))::date
      WHERE assinatura_ate IS NULL`,
    [dias]
  );
  return res.json({ ok: true, atualizados: rowCount });
});

// ── Broadcast: mensagem de atualização para vários usuários ──
// publico: "em_dia" (ativos com assinatura válida) | "ativos" (todos ativos)
adminRouter.post("/broadcast", async (req, res) => {
  const texto = String(req.body?.texto || "").trim();
  const publico = String(req.body?.publico || "em_dia");
  if (texto.length < 2) return res.status(400).json({ error: "texto_vazio", mensagem: "Escreva a mensagem." });
  if (texto.length > 4000) return res.status(400).json({ error: "texto_longo", mensagem: "Máximo de 4000 caracteres." });

  const where =
    publico === "ativos"
      ? `status='ativo'`
      : `status='ativo' AND (assinatura_ate IS NULL OR assinatura_ate >= current_date)`;
  const { rows } = await pool.query(`SELECT id, phone, nome FROM usuarios WHERE ${where}`);

  let enviados = 0;
  let falhas = 0;
  for (const u of rows) {
    const ok = await sendText(u.phone, texto);
    if (ok) {
      enviados++;
      await pool.query(
        `INSERT INTO mensagens (user_id, phone, direcao, tipo, conteudo, intent, provider)
         VALUES ($1,$2,'out','text',$3,'broadcast','admin')`,
        [u.id, u.phone, texto]
      );
    } else {
      falhas++;
    }
    await new Promise((r) => setTimeout(r, 700)); // espaça envios (anti-flood/ban)
  }
  return res.json({ ok: true, total: rows.length, enviados, falhas });
});

// Quantos receberiam o broadcast (pré-contagem para o painel)
adminRouter.get("/broadcast/contagem", async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM usuarios WHERE status='ativo' AND (assinatura_ate IS NULL OR assinatura_ate >= current_date)) AS em_dia,
      (SELECT COUNT(*) FROM usuarios WHERE status='ativo') AS ativos
  `);
  return res.json(rows[0]);
});
