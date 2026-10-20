import { readFile } from "node:fs/promises";

let DatabaseSync;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  // Match the relay fixtures: older Node versions can skip SQLite tests.
}

export const sqliteAvailable = typeof DatabaseSync === "function";

// A separate database, using the gateway's real migration, not the relay schema.
export async function createGatewayTestDatabase() {
  if (!sqliteAvailable) throw new Error("node:sqlite is unavailable in this Node.js version.");
  const sqlite = new DatabaseSync(":memory:");
  try {
    sqlite.exec("PRAGMA foreign_keys = ON");
    for (const name of ["0001_gateway", "0002_private_room_history", "0003_durable_link"]) {
      sqlite.exec(await readFile(new URL("../../gateway/drizzle/" + name + ".sql", import.meta.url), "utf8"));
    }
  } catch (error) {
    sqlite.close();
    throw error;
  }

  const execute = Symbol("execute D1 batch statement");
  function prepared(sql, values = []) {
    const statement = sqlite.prepare(sql);
    const result = () => {
      const info = statement.run(...values);
      return { success: true, meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
    };
    return {
      bind(...boundValues) { return prepared(sql, boundValues); },
      first(column) {
        const row = statement.get(...values);
        return row === undefined ? null : column === undefined ? row : row[column];
      },
      all() { return { success: true, results: statement.all(...values) }; },
      run: result,
      [execute]: result,
    };
  }

  return {
    sqlite,
    prepare: prepared,
    batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results = statements.map(statement => statement[execute]());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
    close() { sqlite.close(); },
  };
}
