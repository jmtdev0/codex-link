import { createHash } from "node:crypto";
import { SCHEMA_SQL } from "./schema-sql.mjs";

export async function ensureSchema(pool, suppliedSql) {
  const sql = suppliedSql ?? SCHEMA_SQL;
  const fingerprint = createHash("sha256").update(sql.replaceAll("\r\n", "\n")).digest("hex");
  const connection = await pool.connect();
  try {
    await connection.query("BEGIN");
    await connection.query("SET LOCAL lock_timeout = '5s'");
    await connection.query("SET LOCAL statement_timeout = '10s'");
    await connection.query("SELECT pg_advisory_xact_lock($1)", [1280199473]);
    await connection.query("CREATE TABLE IF NOT EXISTS link_schema_migrations (version INTEGER PRIMARY KEY, fingerprint TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())");
    const previous = await connection.query("SELECT fingerprint FROM link_schema_migrations WHERE version = 1");
    if (previous.rows.length && previous.rows[0].fingerprint !== fingerprint) throw new Error("Schema version fingerprint mismatch");
    if (!previous.rows.length) {
      await connection.query(sql);
      await connection.query("INSERT INTO link_schema_migrations (version, fingerprint) VALUES (1, $1)", [fingerprint]);
    }
    await connection.query("COMMIT");
  } catch (error) {
    await connection.query("ROLLBACK").catch(() => {});
    throw error;
  } finally { connection.release(); }
}
