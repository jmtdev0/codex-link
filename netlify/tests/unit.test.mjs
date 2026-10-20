import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { translateSql, createPostgresStore } from "../lib/postgres.mjs";
import { createNetlifyService, PUBLIC_ORIGIN } from "../lib/service.mjs";

test("fixed SQL translation binds parameters without rewriting quoted literals", () => {
  const translated = translateSql("SELECT '?' AS literal, room_id FROM link_rooms_v2 WHERE room_id = ?");
  assert.equal(translated.sql, "SELECT '?' AS literal, room_id FROM link_rooms_v2 WHERE room_id = $1");
  assert.equal(translated.parameterCount, 1);
  assert.match(translateSql("INSERT OR IGNORE INTO link_rooms_v2 (room_id) SELECT ? WHERE 1 = 1").sql, /ON CONFLICT DO NOTHING$/);
  assert.match(translateSql("UPDATE link_participants_v2 SET confirmed_cursor = MAX(confirmed_cursor, ?) WHERE participant_id = ?").sql, /GREATEST\(confirmed_cursor, \$1\)/);
  assert.match(translateSql("UPDATE link_deliveries_v2 SET read_at = CASE WHEN ? THEN ? ELSE read_at END").sql, /WHEN \$1::integer <> 0 THEN/);
  assert.throws(() => translateSql("SELECT 1; DROP TABLE anything"));
});

test("transaction failures roll back and release the connection", async () => {
  const queries = []; let released = false;
  const connection = { async query(sql) { queries.push(sql); if (sql.startsWith("INSERT")) throw new Error("synthetic failure"); return { rows: [], rowCount: 0 }; }, release() { released = true; } };
  const store = createPostgresStore({ connect: async () => connection });
  await assert.rejects(store.prepare("INSERT INTO test (value) VALUES (?)").bind("synthetic").run(), /synthetic/);
  assert.ok(queries.includes("BEGIN")); assert.ok(queries.includes("ROLLBACK")); assert.equal(released, true);
  assert.ok(queries.some(sql => sql.includes("pg_advisory_xact_lock")));
  await assert.rejects(store.batch([{}]), /Foreign/);
});

test("public info and signed-out resume do not open the database", async () => {
  let opened = 0;
  const handler = createNetlifyService({ getPool() { opened++; throw new Error("not needed"); }, masterKey: () => undefined });
  const info = await handler(new Request(PUBLIC_ORIGIN + "/link/v1/info"));
  assert.equal(info.status, 200); assert.equal((await info.json()).storage, "postgres");
  assert.equal((await handler(new Request(PUBLIC_ORIGIN + "/link/v1/session"))).status, 401);
  assert.equal(opened, 0);
});

test("canonical origin and trusted hosting context are required", async () => {
  let opened = 0;
  const handler = createNetlifyService({ getPool() { opened++; }, masterKey: () => "A".repeat(43) });
  assert.equal((await handler(new Request("https://other.example/link/v1/info"))).status, 421);
  assert.equal((await handler(new Request(PUBLIC_ORIGIN + "/link/v1/info"), { site: { id: "other-site" } })).status, 503);
  const request = new Request(PUBLIC_ORIGIN + "/link/v1/identity", { method: "POST", headers: { "cf-connecting-ip": "forged-address", "content-type": "application/json" }, body: "{}" });
  assert.equal((await handler(request)).status, 503);
  assert.equal(opened, 0);
});

test("public build contains no legacy relay dependency or embedded credentials", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const client = await readFile(new URL("../public/link-client.mjs", import.meta.url), "utf8");
  const guide = await readFile(new URL("../public/link-guide.txt", import.meta.url), "utf8");
  assert.ok(html.includes("2,000 messages"));
  assert.ok(!html.includes('href="/legacy"'));
  assert.ok(!client.includes("chatgpt.site"));
  assert.ok(guide.includes(PUBLIC_ORIGIN));
  assert.ok(guide.includes("PostgreSQL"));
  assert.ok(!/lks2\.[A-Za-z0-9_-]{43}/.test(html + client + guide));
});

test("storage diagnostics never disclose raw errors or private values", async () => {
  const diagnostics = [];
  const handler = createNetlifyService({ getPool() { throw Object.assign(new Error("private connection-string and message"), { name: "MissingDatabaseConnectionError" }); }, masterKey: () => "A".repeat(43), onError: value => diagnostics.push(value) });
  const response = await handler(new Request(PUBLIC_ORIGIN + "/link/v1/identity", { method: "POST" }), { ip: "synthetic-address" });
  assert.equal(response.status, 503);
  assert.deepEqual(diagnostics, [{ category: "DATABASE_ENVIRONMENT_MISSING" }]);
  assert.ok(!(await response.text()).includes("private connection-string and message"));
});
