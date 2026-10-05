// Applies db/schema.sql. Runs before `next start`; safe to run repeatedly.
import { readFile } from "node:fs/promises";
import { pool } from "../lib/server/db.mjs";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set; skipping migrations.");
  process.exit(0);
}
const sql = await readFile(new URL("../db/schema.sql", import.meta.url), "utf8");
const db = pool();
try {
  await db.query(sql);
  console.log(JSON.stringify({ msg: "migrations applied" }));
} finally {
  await db.end();
}
