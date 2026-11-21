import pg from "pg";
import { attachDatabasePool } from "@neon/functions";

let pool;
export function getLinkPool() {
  if (pool) return pool;
  let url;
  try { url = new URL(process.env.DATABASE_URL); } catch {}
  if (!url || !["postgres:", "postgresql:"].includes(url.protocol) || !url.username || !url.password ||
      !url.hostname.endsWith(".neon.tech") || !url.hostname.includes("-pooler.") || url.pathname !== "/link") {
    throw Object.assign(new Error("Neon runtime database unavailable"), { name: "MissingDatabaseConnectionError" });
  }
  url.search = "";
  pool = new pg.Pool({ connectionString: url.toString(), ssl: { rejectUnauthorized: true }, max: 2,
    idleTimeoutMillis: 10000, connectionTimeoutMillis: 15000, application_name: "agents-link-neon-functions" });
  attachDatabasePool(pool, { onUnexpectedError: () => console.error("Link pool diagnostic: unexpected idle failure") });
  return pool;
}
