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
  r && { id: r.id, paypalEmail: r.paypal_email, vaultId: r.vault_id, spendLimit: Number(r.spend_limit), invoiceId: r.invoice_id, status: r.status, createdAt: r.created_at };

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
    async revokePayer(id) {
      await db.query("UPDATE payers SET status = 'revoked', revoked_at = now() WHERE id = $1", [id]);
    },
  };
}
