import { test } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../lib/server/db.mjs";

// Needs DATABASE_URL (run with --env-file=.env); skipped otherwise.
test("a DATE column reads back as the same YYYY-MM-DD it was written as", { skip: !process.env.DATABASE_URL }, async () => {
  const db = pool();
  try {
    const { rows } = await db.query("SELECT $1::date AS d", ["2026-10-26"]);
    assert.equal(rows[0].d, "2026-10-26");
  } finally {
    await db.end();
    globalThis.__collectpilotPool = undefined;
  }
});
