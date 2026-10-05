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
