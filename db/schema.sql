-- Idempotent schema; applied by scripts/migrate.mjs before the app starts.
CREATE TABLE IF NOT EXISTS pending_connections (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  setup_token_id  text NOT NULL UNIQUE,
  nonce_hash      text NOT NULL UNIQUE,
  invoice_id      text,
  spend_limit     numeric(12, 2) NOT NULL,
  expires_at      timestamptz NOT NULL,
  used_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  paypal_email    text NOT NULL,
  vault_id        text NOT NULL,
  agent_key_hash  text NOT NULL UNIQUE,
  spend_limit     numeric(12, 2) NOT NULL,
  invoice_id      text,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz
);

-- Client setup progress, shown on /connect/done.
ALTER TABLE payers ADD COLUMN IF NOT EXISTS key_saved_at timestamptz;
ALTER TABLE payers ADD COLUMN IF NOT EXISTS first_used_at timestamptz;
ALTER TABLE payers ADD COLUMN IF NOT EXISTS payments_count integer NOT NULL DEFAULT 0;
ALTER TABLE payers ADD COLUMN IF NOT EXISTS paid_total numeric(12, 2) NOT NULL DEFAULT 0;
ALTER TABLE payers ADD COLUMN IF NOT EXISTS last_payment_at timestamptz;

-- Small key/value settings (e.g. the demo clock offset).
CREATE TABLE IF NOT EXISTS app_settings (
  key    text PRIMARY KEY,
  value  text NOT NULL
);

-- Reminder agent: one row per invoice and stage; the unique key stops double drafting.
CREATE TABLE IF NOT EXISTS reminders (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id     text NOT NULL,
  invoice_number text NOT NULL,
  client_email   text NOT NULL,
  stage          smallint NOT NULL,
  days_overdue   integer NOT NULL,
  amount         numeric(12, 2) NOT NULL,
  currency       text NOT NULL,
  risk_bucket    text NOT NULL,
  risk_reason    text NOT NULL,
  language       text NOT NULL,
  subject        text NOT NULL,
  body           text NOT NULL,
  edited         boolean NOT NULL DEFAULT false,
  status         text NOT NULL DEFAULT 'drafted' CHECK (status IN ('drafted', 'sent', 'cancelled')),
  cancel_reason  text,
  drafted_at     timestamptz NOT NULL,
  auto_send_at   timestamptz NOT NULL,
  sent_at        timestamptz,
  sent_by        text,
  UNIQUE (invoice_id, stage)
);

-- Retainers: a monthly PayPal subscription offered to a repeat client.
CREATE TABLE IF NOT EXISTS retainers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id        text NOT NULL UNIQUE,
  client_email     text NOT NULL,
  client_name      text NOT NULL DEFAULT '',
  amount           numeric(12, 2) NOT NULL,
  currency         text NOT NULL,
  description      text NOT NULL,
  plan_id          text NOT NULL,
  subscription_id  text UNIQUE,
  status           text NOT NULL DEFAULT 'offered' CHECK (status IN ('offered', 'pending', 'active', 'suspended', 'cancelled')),
  payments_count   integer NOT NULL DEFAULT 0,
  paid_total       numeric(12, 2) NOT NULL DEFAULT 0,
  last_payment_at  timestamptz,
  last_sale_id     text,
  activated_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
