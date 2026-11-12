-- ============================================================
-- Assistente Pessoal — schema inicial (multi-tenant por usuário)
-- ============================================================

-- Pessoas cadastradas. ESTA TABELA É A ALLOWLIST.
-- Só quem está aqui com status='ativo' recebe resposta do bot.
CREATE TABLE IF NOT EXISTS usuarios (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  phone         text UNIQUE NOT NULL,                 -- E.164: 5561999999999
  nome          text,
  status        text NOT NULL DEFAULT 'ativo',        -- ativo | suspenso | trial | cancelado
  timezone      text NOT NULL DEFAULT 'America/Sao_Paulo',
  plano         text NOT NULL DEFAULT 'free',         -- free | pro
  assinatura_ate date,                                -- vencimento da assinatura (null = sem limite)
  consentimento_lgpd_at timestamptz,
  last_interaction_at   timestamptz,                  -- coração do gate anti-ban
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_usuarios_phone  ON usuarios (phone);
CREATE INDEX IF NOT EXISTS idx_usuarios_status ON usuarios (status);

-- Tarefas pontuais ("dentista terça 15h")
CREATE TABLE IF NOT EXISTS tarefas (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  titulo      text NOT NULL,
  due_at      timestamptz,
  lembrete_at timestamptz,
  status      text NOT NULL DEFAULT 'pendente',       -- pendente | concluida | cancelada
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tarefas_user     ON tarefas (user_id, status);
CREATE INDEX IF NOT EXISTS idx_tarefas_lembrete ON tarefas (status, lembrete_at) WHERE lembrete_at IS NOT NULL;

-- Rotinas recorrentes ("toda segunda/quarta/sexta 8h academia")
CREATE TABLE IF NOT EXISTS rotinas (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  titulo      text NOT NULL,
  dias_semana int[] NOT NULL,                         -- {1,3,5} (0=domingo)
  hora        time NOT NULL,
  ativa       boolean NOT NULL DEFAULT true,
  proxima_ocorrencia timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rotinas_proxima ON rotinas (ativa, proxima_ocorrencia) WHERE ativa;

-- Controle financeiro
CREATE TABLE IF NOT EXISTS lancamentos (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  tipo        text NOT NULL,                          -- entrada | saida
  valor       numeric(12,2) NOT NULL,
  categoria   text,
  descricao   text,
  ocorrido_em date NOT NULL DEFAULT current_date,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lancamentos_user ON lancamentos (user_id, ocorrido_em);

-- Idempotência: nunca mandar o mesmo lembrete 2x
CREATE TABLE IF NOT EXISTS lembretes_enviados (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  ref_tipo   text NOT NULL,                           -- tarefa | rotina
  ref_id     uuid NOT NULL,
  ocorrencia timestamptz NOT NULL,
  enviado_em timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ref_tipo, ref_id, ocorrencia)
);

-- Fila de reengajamento (lembrete segurado p/ usuário dormente)
CREATE TABLE IF NOT EXISTS pendencias_reengajamento (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  texto       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  entregue_em timestamptz
);
CREATE INDEX IF NOT EXISTS idx_reengaj_pendente ON pendencias_reengajamento (user_id) WHERE entregue_em IS NULL;

-- Histórico de conversa (memória + auditoria)
CREATE TABLE IF NOT EXISTS mensagens (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid REFERENCES usuarios(id) ON DELETE SET NULL,
  phone      text NOT NULL,
  direcao    text NOT NULL,                           -- in | out
  tipo       text NOT NULL DEFAULT 'text',            -- text | audio
  conteudo   text,
  intent     text,
  provider   text,                                    -- groq | deepseek | template
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mensagens_user ON mensagens (user_id, created_at);

-- Operadores do PAINEL admin (você e equipe) — diferente de 'usuarios' (clientes do bot)
CREATE TABLE IF NOT EXISTS admins (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text UNIQUE NOT NULL,
  nome          text,
  password_hash text NOT NULL,
  role          text NOT NULL DEFAULT 'admin',        -- admin | operador
  ativo         boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);
