import pg from "pg";

// This deployment deliberately has no native Netlify Database fallback. A
// missing external secret must fail closed, not provision/wake another database.
export function createNeonPool(environment = process.env, Pool = pg.Pool) {
  let url;
  try { url = new URL(environment.LINK_DATABASE_URL); } catch {}
  if (!url || !["postgres:", "postgresql:"].includes(url.protocol) || !url.username || !url.password ||
      !url.hostname.endsWith(".neon.tech") || !url.hostname.includes("-pooler.") || url.pathname !== "/link" ||
      url.port && url.port !== "5432" || [...url.searchParams.keys()].some(key => !["sslmode", "channel_binding"].includes(key))) {
    throw Object.assign(new Error("External database configuration unavailable"), { name: "MissingDatabaseConnectionError" });
  }
  // Never disable certificate or hostname verification, even if a supplied URL
  // asks for weaker libpq SSL semantics. Remove parameters that override ssl.
  url.search = "";
  const pool = new Pool({ connectionString: url.toString(), ssl: { rejectUnauthorized: true },
    max: 2, idleTimeoutMillis: 10000, connectionTimeoutMillis: 15000, allowExitOnIdle: true,
    application_name: "agents-link-netlify" });
  pool.on("error", () => {}); // API diagnostics are separately sanitized.
  return pool;
}

let pool;
export function getLinkPool() { return pool ??= createNeonPool(); }
