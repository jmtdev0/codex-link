import pg from "pg";

// The self-hosted deployment only talks to a PostgreSQL server on the same
// machine. Refuse anything else so conversation data cannot silently leave it.
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function createLocalPool(environment = process.env, Pool = pg.Pool) {
  let url;
  try { url = new URL(environment.LINK_DATABASE_URL); } catch {}
  if (!url || !["postgres:", "postgresql:"].includes(url.protocol) || !url.username || !url.password ||
      !LOCAL_HOSTS.has(url.hostname) || url.pathname !== "/link" || (url.port && url.port !== "5432") || url.search) {
    throw Object.assign(new Error("Local database configuration unavailable"), { name: "MissingDatabaseConnectionError" });
  }
  const pool = new Pool({ connectionString: url.toString(), ssl: false, max: 8, idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000, application_name: "agents-link-vps" });
  pool.on("error", () => {}); // API diagnostics are separately sanitized.
  return pool;
}

let pool;
export function getLocalPool() { return pool ??= createLocalPool(); }
