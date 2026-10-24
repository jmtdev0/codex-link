import test from "node:test";
import assert from "node:assert/strict";
import { createNeonPool } from "../lib/database.mjs";
import { readFile } from "node:fs/promises";

test("external database fails closed and cannot fall back to native Netlify", () => {
  for (const LINK_DATABASE_URL of [undefined, "invalid", "postgres://x:y@localhost/link", "postgres://x:y@ep-test.neon.tech/link", "postgres://x:y@ep-test-pooler.neon.tech/other", "postgres://x:y@ep-test-pooler.neon.tech/link?uselibpqcompat=true"]) {
    assert.throws(() => createNeonPool({ LINK_DATABASE_URL }), { name: "MissingDatabaseConnectionError" });
  }
});

test("Neon uses a small idle pool and verified TLS, overriding weak URL SSL modes", () => {
  let options;
  class Pool { constructor(value) { options = value; } on(name, fn) { assert.equal(name, "error"); assert.equal(typeof fn, "function"); } }
  createNeonPool({ LINK_DATABASE_URL: "postgresql://synthetic:synthetic@ep-test-pooler.us-east-2.aws.neon.tech/link?sslmode=disable&channel_binding=require" }, Pool);
  assert.deepEqual(options.ssl, { rejectUnauthorized: true });
  assert.equal(new URL(options.connectionString).search, "");
  assert.equal(options.max, 2); assert.equal(options.allowExitOnIdle, true);
});

test("API and cleanup use only the external pool and avoid per-request DDL/cleanup", async () => {
  const api = await readFile(new URL("../functions/link.mjs", import.meta.url), "utf8");
  const cleanup = await readFile(new URL("../functions/cleanup.mjs", import.meta.url), "utf8");
  assert.ok(!api.includes("@netlify/database") && !cleanup.includes("@netlify/database"));
  assert.ok(api.includes("initializeSchema: false")); assert.ok(api.includes("cleanupOnRequest: false"));
  assert.ok(api.includes("clientPolling: true")); assert.ok(!cleanup.includes("ensureSchema"));
  assert.ok(cleanup.includes('schedule: "@daily"'));
});
