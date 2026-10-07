// Postgres pool (one per process) and the store used by lib/connect.mjs.
import pg from "pg";

export function pool() {
  const url = process.env.DATABASE_URL ?? "";
  // Render's external URL (local dev) needs TLS; its internal URL does not. The sslmode
  // flag is stripped so pg uses the ssl option below instead of verify-full.
  const tls = /sslmode=require/.test(url);
  globalThis.__collectpilotPool ??= new pg.Pool({
    connectionString: url.replace(/[?&]sslmode=require/, ""),
    max: 5,
    ssl: tls ? { rejectUnauthorized: false } : undefined,
  });
  return globalThis.__collectpilotPool;
}

const toPending = (r) =>
  r && { id: r.id, setupTokenId: r.setup_token_id, invoiceId: r.invoice_id, spendLimit: Number(r.spend_limit), expiresAt: r.expires_at, usedAt: r.used_at };
const toPayer = (r) =>
  r && {
    id: r.id,
    paypalEmail: r.paypal_email,
    vaultId: r.vault_id,
    spendLimit: Number(r.spend_limit),
    invoiceId: r.invoice_id,
    status: r.status,
    createdAt: r.created_at,
    keySavedAt: r.key_saved_at,
    firstUsedAt: r.first_used_at,
    paymentsCount: r.payments_count,
    paidTotal: Number(r.paid_total),
    lastPaymentAt: r.last_payment_at,
  };

const toReminder = (r) =>
  r && {
    id: r.id,
    invoiceId: r.invoice_id,
    invoiceNumber: r.invoice_number,
    clientEmail: r.client_email,
    stage: r.stage,
    daysOverdue: r.days_overdue,
    amount: Number(r.amount),
    currency: r.currency,
    riskBucket: r.risk_bucket,
    riskReason: r.risk_reason,
    language: r.language,
    subject: r.subject,
    body: r.body,
    edited: r.edited,
    status: r.status,
    cancelReason: r.cancel_reason,
    draftedAt: r.drafted_at,
    autoSendAt: r.auto_send_at,
    sentAt: r.sent_at,
    sentBy: r.sent_by,
  };

const toRetainer = (r) =>
  r && {
    id: r.id,
    publicId: r.public_id,
    clientEmail: r.client_email,
    clientName: r.client_name,
    amount: Number(r.amount),
    currency: r.currency,
    description: r.description,
    planId: r.plan_id,
    subscriptionId: r.subscription_id,
    status: r.status,
    paymentsCount: r.payments_count,
    paidTotal: Number(r.paid_total),
    lastPaymentAt: r.last_payment_at,
    lastSaleId: r.last_sale_id,
    activatedAt: r.activated_at,
    createdAt: r.created_at,
  };

// Columns updateRetainer may touch, keyed by the camelCase field name.
const RETAINER_COLUMNS = {
  status: "status",
  paymentsCount: "payments_count",
  paidTotal: "paid_total",
  lastPaymentAt: "last_payment_at",
  lastSaleId: "last_sale_id",
  activatedAt: "activated_at",
};

export function pgStore(db = pool()) {
  const one = async (sql, params) => (await db.query(sql, params)).rows[0] ?? null;
  return {
    async insertPending({ setupTokenId, nonceHash, invoiceId, spendLimit, expiresAt }) {
      await db.query(
        "INSERT INTO pending_connections (setup_token_id, nonce_hash, invoice_id, spend_limit, expires_at) VALUES ($1, $2, $3, $4, $5)",
        [setupTokenId, nonceHash, invoiceId, spendLimit, expiresAt],
      );
    },
    findPending: async (nonceHash) => toPending(await one("SELECT * FROM pending_connections WHERE nonce_hash = $1", [nonceHash])),
    async markPendingUsed(id) {
      await db.query("UPDATE pending_connections SET used_at = now() WHERE id = $1", [id]);
    },
    insertPayer: async ({ paypalEmail, vaultId, agentKeyHash, spendLimit, invoiceId }) =>
      toPayer(
        await one(
          "INSERT INTO payers (paypal_email, vault_id, agent_key_hash, spend_limit, invoice_id) VALUES ($1, $2, $3, $4, $5) RETURNING *",
          [paypalEmail, vaultId, agentKeyHash, spendLimit, invoiceId],
        ),
      ),
    findActivePayerByKeyHash: async (hash) =>
      toPayer(await one("SELECT * FROM payers WHERE agent_key_hash = $1 AND status = 'active'", [hash])),
    findPayer: async (id) => toPayer(await one("SELECT * FROM payers WHERE id = $1", [id])),
    async markKeySaved(id) {
      await db.query("UPDATE payers SET key_saved_at = COALESCE(key_saved_at, now()) WHERE id = $1", [id]);
    },
    async markUsed(id) {
      await db.query("UPDATE payers SET first_used_at = now() WHERE id = $1 AND first_used_at IS NULL", [id]);
    },
    async recordPayment(id, amount) {
      await db.query(
        "UPDATE payers SET payments_count = payments_count + 1, paid_total = paid_total + $2, last_payment_at = now() WHERE id = $1",
        [id, amount],
      );
    },
    async getSetting(key) {
      return (await one("SELECT value FROM app_settings WHERE key = $1", [key]))?.value ?? null;
    },
    async setSetting(key, value) {
      await db.query(
        "INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
        [key, String(value)],
      );
    },
    listReminderKeys: async () =>
      (await db.query("SELECT invoice_id, stage FROM reminders")).rows.map((r) => ({ invoiceId: r.invoice_id, stage: r.stage })),
    async insertReminder(r) {
      const res = await db.query(
        `INSERT INTO reminders (invoice_id, invoice_number, client_email, stage, days_overdue, amount, currency, risk_bucket,
           risk_reason, language, subject, body, drafted_at, auto_send_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (invoice_id, stage) DO NOTHING`,
        [r.invoiceId, r.invoiceNumber, r.clientEmail, r.stage, r.daysOverdue, r.amount, r.currency, r.riskBucket,
          r.riskReason, r.language, r.subject, r.body, r.draftedAt, r.autoSendAt],
      );
      return res.rowCount === 1;
    },
    remindersDue: async (now) =>
      (await db.query("SELECT * FROM reminders WHERE status = 'drafted' AND auto_send_at <= $1 ORDER BY auto_send_at", [now])).rows.map(toReminder),
    listReminders: async () =>
      (await db.query("SELECT * FROM reminders ORDER BY (status = 'drafted') DESC, drafted_at DESC LIMIT 100")).rows.map(toReminder),
    findReminder: async (id) => toReminder(await one("SELECT * FROM reminders WHERE id = $1", [id])),
    async updateReminderText(id, subject, body) {
      await db.query("UPDATE reminders SET subject = $2, body = $3, edited = true WHERE id = $1 AND status = 'drafted'", [id, subject, body]);
    },
    async markReminderSent(id, by, now) {
      await db.query("UPDATE reminders SET status = 'sent', sent_by = $2, sent_at = $3 WHERE id = $1 AND status = 'drafted'", [id, by, now]);
    },
    async cancelReminder(id, reason = "cancelled by you") {
      await db.query("UPDATE reminders SET status = 'cancelled', cancel_reason = $2 WHERE id = $1 AND status = 'drafted'", [id, reason]);
    },
    async revokePayer(id) {
      await db.query("UPDATE payers SET status = 'revoked', revoked_at = now() WHERE id = $1", [id]);
    },
    insertRetainer: async ({ publicId, clientEmail, clientName, amount, currency, description, planId }) =>
      toRetainer(
        await one(
          `INSERT INTO retainers (public_id, client_email, client_name, amount, currency, description, plan_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
          [publicId, clientEmail, clientName, amount, currency, description, planId],
        ),
      ),
    listRetainers: async () => (await db.query("SELECT * FROM retainers ORDER BY created_at DESC LIMIT 100")).rows.map(toRetainer),
    findRetainer: async (id) => toRetainer(await one("SELECT * FROM retainers WHERE id = $1", [id])),
    findRetainerByPublicId: async (publicId) => toRetainer(await one("SELECT * FROM retainers WHERE public_id = $1", [publicId])),
    findRetainerBySubscription: async (subId) => toRetainer(await one("SELECT * FROM retainers WHERE subscription_id = $1", [subId])),
    async setRetainerSubscription(id, subId) {
      await db.query("UPDATE retainers SET subscription_id = $2, status = 'pending' WHERE id = $1 AND status IN ('offered', 'pending')", [id, subId]);
    },
    async updateRetainer(id, patch) {
      const keys = Object.keys(patch).filter((k) => RETAINER_COLUMNS[k]);
      if (!keys.length) return;
      const sets = keys.map((k, i) => `${RETAINER_COLUMNS[k]} = $${i + 2}`).join(", ");
      await db.query(`UPDATE retainers SET ${sets} WHERE id = $1`, [id, ...keys.map((k) => patch[k])]);
    },
  };
}
