import { Router } from "express";
import bcrypt from "bcryptjs";
import { pool } from "../db";
import { config } from "../config";
import { signToken } from "../auth/jwt";
import { adminRequired, AuthedRequest } from "../auth/middleware";
import { sendText } from "../evolution/client";

export const authRouter = Router();

function genCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}
function maskPhone(p: string): string {
  return p.length >= 4 ? `••••${p.slice(-4)}` : "••••";
}

authRouter.post("/login", async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const senha = String(req.body?.senha || "");
  if (!email || !senha) return res.status(400).json({ error: "dados_invalidos" });

  const { rows } = await pool.query(
    `SELECT id, email, nome, password_hash, role, ativo FROM admins WHERE email=$1`,
    [email]
  );
  const a = rows[0];
  if (!a || !a.ativo) return res.status(401).json({ error: "credenciais_invalidas" });

  const ok = await bcrypt.compare(senha, a.password_hash);
  if (!ok) return res.status(401).json({ error: "credenciais_invalidas" });

  const token = signToken({ sub: a.id, email: a.email, nome: a.nome || a.email, role: a.role });
  res.cookie("token", token, {
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: "lax",
    maxAge: 7 * 24 * 3600 * 1000,
  });
  return res.json({ admin: { id: a.id, email: a.email, nome: a.nome, role: a.role }, token });
});

authRouter.post("/logout", (_req, res) => {
  res.clearCookie("token");
  return res.json({ ok: true });
});

authRouter.get("/me", adminRequired, (req: AuthedRequest, res) => {
  return res.json({ admin: req.admin });
});

// Perfil (ler nome/email/telefone de recuperação)
authRouter.get("/perfil", adminRequired, async (req: AuthedRequest, res) => {
  const { rows } = await pool.query(`SELECT email, nome, phone FROM admins WHERE id=$1`, [req.admin!.sub]);
  return res.json({ perfil: rows[0] || null });
});

// Atualizar telefone de recuperação
authRouter.post("/perfil", adminRequired, async (req: AuthedRequest, res) => {
  const phone = String(req.body?.phone || "").replace(/\D/g, "") || null;
  await pool.query(`UPDATE admins SET phone=$1 WHERE id=$2`, [phone, req.admin!.sub]);
  return res.json({ ok: true, mensagem: "Telefone de recuperação salvo ✅" });
});

// Esqueci a senha — envia código de 6 dígitos pro WhatsApp do admin
authRouter.post("/forgot", async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const { rows } = await pool.query(`SELECT id, phone FROM admins WHERE email=$1 AND ativo=true`, [email]);
  const a = rows[0];
  if (!a || !a.phone) {
    return res.json({ ok: true, enviado: false, mensagem: "Se a conta existir e tiver telefone de recuperação cadastrado, o código será enviado." });
  }
  const code = genCode();
  const hash = await bcrypt.hash(code, 10);
  await pool.query(`UPDATE admin_resets SET used=true WHERE admin_id=$1 AND used=false`, [a.id]);
  await pool.query(
    `INSERT INTO admin_resets (admin_id, code_hash, expires_at) VALUES ($1,$2, now() + interval '10 minutes')`,
    [a.id, hash]
  );
  const enviado = await sendText(
    a.phone,
    `🔐 Seu código de recuperação do *Assistente Pessoal* é: *${code}*\n\nVálido por 10 minutos. Se não foi você, ignore esta mensagem.`
  );
  return res.json({
    ok: true,
    enviado,
    destino: maskPhone(a.phone),
    mensagem: enviado ? `Código enviado pro WhatsApp ${maskPhone(a.phone)} 📱` : "Não consegui enviar o código (o WhatsApp do assistente está conectado?).",
  });
});

// Redefinir senha com o código
authRouter.post("/reset", async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const code = String(req.body?.code || "").replace(/\D/g, "");
  const nova = String(req.body?.senha_nova || "");
  if (nova.length < 6) return res.status(400).json({ error: "senha_curta", mensagem: "A nova senha precisa ter ao menos 6 caracteres." });

  const { rows } = await pool.query(
    `SELECT r.id, r.code_hash, r.tentativas, r.admin_id
       FROM admin_resets r JOIN admins a ON a.id = r.admin_id
      WHERE a.email=$1 AND r.used=false AND r.expires_at > now()
      ORDER BY r.created_at DESC LIMIT 1`,
    [email]
  );
  const r = rows[0];
  if (!r) return res.status(400).json({ error: "codigo_invalido", mensagem: "Código inválido ou expirado. Solicite um novo." });
  if (r.tentativas >= 5) {
    await pool.query(`UPDATE admin_resets SET used=true WHERE id=$1`, [r.id]);
    return res.status(429).json({ error: "muitas_tentativas", mensagem: "Muitas tentativas. Solicite um novo código." });
  }
  const ok = await bcrypt.compare(code, r.code_hash);
  if (!ok) {
    await pool.query(`UPDATE admin_resets SET tentativas=tentativas+1 WHERE id=$1`, [r.id]);
    return res.status(400).json({ error: "codigo_invalido", mensagem: "Código incorreto." });
  }
  const hash = await bcrypt.hash(nova, 12);
  await pool.query(`UPDATE admins SET password_hash=$1 WHERE id=$2`, [hash, r.admin_id]);
  await pool.query(`UPDATE admin_resets SET used=true WHERE id=$1`, [r.id]);
  return res.json({ ok: true, mensagem: "Senha redefinida! Já pode entrar. ✅" });
});

// Alterar senha (logado)
authRouter.post("/change-password", adminRequired, async (req: AuthedRequest, res) => {
  const atual = String(req.body?.senha_atual || "");
  const nova = String(req.body?.senha_nova || "");
  if (nova.length < 6) return res.status(400).json({ error: "senha_curta", mensagem: "A nova senha precisa ter ao menos 6 caracteres." });
  const { rows } = await pool.query(`SELECT password_hash FROM admins WHERE id=$1`, [req.admin!.sub]);
  if (!rows[0]) return res.status(404).json({ error: "nao_encontrado" });
  const ok = await bcrypt.compare(atual, rows[0].password_hash);
  if (!ok) return res.status(401).json({ error: "senha_atual_incorreta", mensagem: "Senha atual incorreta." });
  const hash = await bcrypt.hash(nova, 12);
  await pool.query(`UPDATE admins SET password_hash=$1 WHERE id=$2`, [hash, req.admin!.sub]);
  return res.json({ ok: true, mensagem: "Senha alterada com sucesso! ✅" });
});
