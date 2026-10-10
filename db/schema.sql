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

-- Payment schedules: a job split into dated parts the client approves once (milestones or chunks).
CREATE TABLE IF NOT EXISTS schedules (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id    text NOT NULL UNIQUE,
  mode         text NOT NULL CHECK (mode IN ('milestones', 'chunks')),
  title        text NOT NULL,
  client_email text NOT NULL,
  client_name  text NOT NULL DEFAULT '',
  currency     text NOT NULL,
  total        numeric(12, 2) NOT NULL,
  status       text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'approved', 'cancelled')),
  autopay      boolean NOT NULL DEFAULT false,
  payer_id     uuid REFERENCES payers (id),
  invoice_id   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  approved_at  timestamptz
);

CREATE TABLE IF NOT EXISTS schedule_parts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id        uuid NOT NULL REFERENCES schedules (id),
  seq                smallint NOT NULL,
  name               text NOT NULL,
  amount             numeric(12, 2) NOT NULL,
  due_date           date NOT NULL,
  status             text NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'sent', 'paid', 'on_hold', 'cancelled')),
  status_before_hold text,
  invoice_id         text,
  hold_note          text NOT NULL DEFAULT '',
  held_at            timestamptz,
  proposed_due_date  date,
  paid_at            timestamptz,
  capture_id         text,
  UNIQUE (schedule_id, seq)
);

-- Every auto-pay attempt, kept as the audit trail shown to both sides.
CREATE TABLE IF NOT EXISTS autopay_charges (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  part_id      uuid NOT NULL REFERENCES schedule_parts (id),
  amount       numeric(12, 2) NOT NULL,
  outcome      text NOT NULL CHECK (outcome IN ('captured', 'failed', 'unconfirmed', 'over_limit')),
  capture_id   text,
  detail       text NOT NULL DEFAULT '',
  attempted_at timestamptz NOT NULL DEFAULT now()
);

-- A PayPal approval started from a payment schedule (auto-pay) rather than for an AI agent.
ALTER TABLE pending_connections ADD COLUMN IF NOT EXISTS schedule_id uuid;

-- At most one successful auto-pay capture is ever recorded per part.
CREATE UNIQUE INDEX IF NOT EXISTS autopay_one_capture_per_part ON autopay_charges (part_id) WHERE outcome = 'captured';

-- Per-milestone auto-pay switch, and the freelancer's "fixed" mark on a held part.
ALTER TABLE schedule_parts ADD COLUMN IF NOT EXISTS autopay boolean NOT NULL DEFAULT true;
ALTER TABLE schedule_parts ADD COLUMN IF NOT EXISTS fixed_at timestamptz;

-- The "Not done yet" conversation on a part: client and freelancer messages, in order.
CREATE TABLE IF NOT EXISTS part_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  part_id     uuid NOT NULL REFERENCES schedule_parts (id),
  author      text NOT NULL CHECK (author IN ('client', 'freelancer')),
  kind        text NOT NULL CHECK (kind IN ('hold', 'reply', 'fixed', 'still_not_done', 'confirmed', 'released', 'date_proposed', 'date_approved')),
  body        text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS part_messages_by_part ON part_messages (part_id, created_at);
