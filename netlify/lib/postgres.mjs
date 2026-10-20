// A deliberately small adapter for Link's fixed, internal SQL statements.
// It is not a general-purpose SQLite-to-Postgres translator. Never accept SQL
// from a request. Values always remain separate, bound query parameters.
const MUTATION_LOCK = 1280199474;
const NUMERIC = new Set(["count", "value", "sequence", "size_bytes", "created_at", "expires_at", "closed_at", "revoked_at", "consented_at", "offered_cursor", "confirmed_cursor", "read_cursor", "confirmed_at", "read_at", "window_started_at", "request_count"]);

export function translateSql(source) {
  if (typeof source !== "string" || !source.trim() || /;|--|\/\*/.test(source)) throw new Error("Unsupported internal SQL");
  const ignore = /^INSERT OR IGNORE INTO /i.test(source);
  let sql = source.replace(/^INSERT OR IGNORE INTO /i, "INSERT INTO ");
  let parameter = 0;
  sql = sql.replace(/'(?:''|[^'])*'|\?/g, match => match === "?" ? "$" + (++parameter) : match);
  sql = sql.replace(/\bMAX\((offered_cursor|confirmed_cursor|read_cursor),\s*(\$\d+)\)/g, "GREATEST($1, $2)");
  sql = sql.replace(/CASE WHEN (\$\d+) THEN/g, "CASE WHEN $1::integer <> 0 THEN");
  if (ignore) {
    if (/ON CONFLICT/i.test(sql) || /RETURNING/i.test(sql)) throw new Error("Unsupported internal conflict statement");
    sql += " ON CONFLICT DO NOTHING";
  }
  // In Postgres, target and EXCLUDED columns must be disambiguated in this upsert.
  if (/^INSERT INTO link_gateway_limits /i.test(sql)) {
    sql = sql.replace(/WHEN window_started_at/g, "WHEN link_gateway_limits.window_started_at")
      .replace(/ELSE window_started_at/g, "ELSE link_gateway_limits.window_started_at")
      .replace(/ELSE request_count \+ 1/g, "ELSE link_gateway_limits.request_count + 1");
  }
  return { sql, parameterCount: parameter };
}

function normalize(row) {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => {
    if (NUMERIC.has(key) && value !== null && (typeof value === "string" || typeof value === "bigint")) {
      const number = Number(value);
      if (!Number.isSafeInteger(number)) throw new Error("Unsafe database integer");
      return [key, number];
    }
    return [key, value];
  }));
}

export function createPostgresStore(pool) {
  const owned = new WeakSet();
  const plans = new WeakMap();
  async function execute(connection, statement) {
    const plan = plans.get(statement);
    if (!plan) throw new Error("Foreign database statement");
    const result = await connection.query(plan.sql, plan.params);
    return { results: result.rows.map(normalize), meta: { changes: result.rowCount ?? 0 } };
  }
  async function mutation(statements) {
    if (!statements.every(statement => owned.has(statement))) throw new Error("Foreign database statement");
    const connection = await pool.connect();
    try {
      await connection.query("BEGIN");
      await connection.query("SET LOCAL lock_timeout = '3s'");
      await connection.query("SET LOCAL statement_timeout = '5s'");
      // D1 serializes writes. Match that guarantee across all Netlify instances,
      // including setup capacity checks and MAX(sequence)+1 allocation. This
      // lock covers short database mutations, NEVER a receive/long-poll wait.
      await connection.query("SELECT pg_advisory_xact_lock($1)", [MUTATION_LOCK]);
      const result = [];
      for (const statement of statements) result.push(await execute(connection, statement));
      await connection.query("COMMIT");
      return result;
    } catch (error) {
      await connection.query("ROLLBACK").catch(() => {});
      throw error;
    } finally { connection.release(); }
  }
  function prepare(source, params = []) {
    const translated = translateSql(source);
    const statement = {
      bind(...values) {
        if (values.length !== translated.parameterCount) throw new Error("Internal SQL parameter mismatch");
        return prepare(source, values);
      },
      async run() { return (await mutation([statement]))[0]; },
      async first(column) {
        if (params.length !== translated.parameterCount) throw new Error("Unbound internal SQL");
        const result = /^SELECT /i.test(source.trim()) ? await execute(pool, statement) : (await mutation([statement]))[0];
        const row = result.results[0];
        return row ? column === undefined ? row : row[column] : null;
      },
      async all() {
        if (!/^SELECT /i.test(source.trim())) throw new Error("Use run for mutations");
        if (params.length !== translated.parameterCount) throw new Error("Unbound internal SQL");
        return execute(pool, statement);
      },
    };
    plans.set(statement, { ...translated, params });
    owned.add(statement);
    return statement;
  }
  return { prepare, batch: mutation };
}
