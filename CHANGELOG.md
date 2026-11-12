# Changelog — assistente-pessoal

Histórico de alterações (gerado do git).

- **2026-06-06** — feat: producao-grade - DeepSeek orquestra a classificacao (100% eval, sem rate-limit Groq) + validacao deterministica + confirmacao para financas/leads + eval set
- **2026-06-06** — fix: anti-alucinacao na extracao (modelo 70b + prompt rigido + guarda de confianca/titulo) + boas-vindas idempotente (nao repete)
- **2026-06-05** — feat: CRM vinculado por email da conta do cliente (leads vao pro dono certo) no lugar do toggle
- **2026-06-05** — feat: gestao de assinatura por planos (Essencial/Pro/Business) com recursos e CRM por plano
- **2026-06-05** — feat: bot cria lead no CRM (intent criar_lead + cliente CRM + gate crm_ativo)
- **2026-06-05** — feat: toggle CRM por assinante no painel
- **2026-06-05** — fix: fuso horario (TZ Sao Paulo), anti-alucinacao na conversa, opcao ambos audio+texto, pergunta de preferencia unica (sem repetir)
- **2026-06-05** — feat: alterar senha (logado) + esqueci a senha (codigo via WhatsApp, uso unico, expira 10min)
- **2026-06-03** — feat: gestao de assinaturas (pagamento em dia/vencido, renovar, toggle ativar/desativar, boas-vindas automatica)
- **2026-06-03** — feat: painel admin (login, contatos/assinaturas, conexao WhatsApp QR)
- **2026-06-03** — feat: assistente pessoal - infra Evolution + app (allowlist, intencao Groq/DeepSeek, handlers, lembretes)

