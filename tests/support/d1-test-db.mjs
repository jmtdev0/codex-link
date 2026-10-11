import { readFile } from "node:fs/promises";

let DatabaseSync;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  // Node versions without the built-in SQLite module still run the other tests.
}

export const sqliteAvailable = typeof DatabaseSync === "function";

export async function createD1TestDatabase() {
  if (!sqliteAvailable) throw new Error("node:sqlite is unavailable in this Node.js version.");
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const migrations = await Promise.all([
    readFile(new URL("../../site/drizzle/0001_codex_link_relay.sql", import.meta.url), "utf8"),
    readFile(new URL("../../site/drizzle/0002_room_capabilities_and_rate_limits.sql", import.meta.url), "utf8"),
  ]);
  for (const migration of migrations) sqlite.exec(migration);

  const database = {
    sqlite,
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      let values = [];
      return {
        bind(...boundValues) {
          values = boundValues;
          return this;
        },
        all() {
          return { results: statement.all(...values) };
        },
        first() {
          return statement.get(...values) ?? null;
        },
        run() {
          return statement.run(...values);
        },
      };
    },
    batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results = statements.map((statement) => statement.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
    close() {
      sqlite.close();
    },
  };
  return database;
}
