import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createDurableLink } from "../worker/link-v2.js";
import { createLinkClient } from "../worker/link-client.js";
import { TestD1 } from "./support/d1.mjs";

function fixture(t) {
  const DB = new TestD1(), env = { DB, LINK_GATEWAY_MASTER_KEY: randomBytes(32).toString("base64url") };
  const server = createDurableLink({ clientPolling: true, cleanupOnRequest: false, maxCreates: 100, maxIngress: 10000, maxRequests: 10000 });
  const calls = []; let time = 0;
  const wire = async (url, init) => {
    calls.push(new URL(url).pathname);
    return server.fetch(new Request(url, { ...init, headers: { ...init.headers, "cf-connecting-ip": "synthetic-polling" } }), env);
  };
  t.after(() => DB.close());
  const client = (extra = {}) => createLinkClient({ baseUrl: "https://link.test", consentToPlaintextGateway: true, fetch: wire, now: () => time, sleep: async ms => { time += ms; }, ...extra });
  return { DB, client, calls, time: () => time, advance: ms => { time += ms; } };
}

test("client waiting uses three short checks for a 25-second window and no empty receipts", async t => {
  const f = fixture(t), owner = f.client(); await owner.create(); f.calls.length = 0;
  const batch = await owner.receive({ waitMs: 25000 });
  assert.equal(f.time(), 25000); assert.equal(batch.messages.length, 0);
  assert.equal(batch.waitMode, "client"); assert.equal(batch.pollAfterMs, 10000);
  assert.equal(f.calls.filter(x => x.endsWith("/receive")).length, 3);
  assert.ok(!f.calls.some(x => x.endsWith("/confirm")));
  assert.equal(f.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM link_waiters_v2").get().n, 0);
});

test("a message arriving during local sleep is returned once without an implicit read claim", async t => {
  const f = fixture(t), owner = f.client(), room = await owner.create(); let sent = false;
  const peer = f.client({ sleep: async ms => { f.advance(ms); if (!sent) { sent = true; await owner.send("Synthetic local-wait reply", { requestId: "local-wait" }); } } });
  await peer.join(room.invitation);
  const batch = await peer.receive({ waitMs: 25000, confirmReceipt: false });
  assert.equal(f.time(), 10000); assert.equal(batch.messages[0].text, "Synthetic local-wait reply");
  assert.equal((await owner.outbox("local-wait")).recipients[0].state, "queued");
  await peer.markRead(batch.nextCursor);
  assert.equal((await owner.outbox("local-wait")).recipients[0].state, "read-confirmed");
  const replay = await peer.receive({ waitMs: 0 }); assert.equal(replay.messages.length, 0);
});

test("local polling can abort promptly without a new identity or another request", async t => {
  const f = fixture(t), controller = new AbortController();
  const owner = f.client({ sleep: async () => { controller.abort(); } }); await owner.create();
  await assert.rejects(owner.receive({ waitMs: 25000, signal: controller.signal }), { code: "ABORTED" });
  assert.equal(f.calls.filter(x => x.endsWith("/receive")).length, 1);
  assert.equal(f.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM link_participants_v2").get().n, 1);
});

test("empty receive avoids no-op cursor writes and disabled request cleanup", async t => {
  const f = fixture(t), owner = f.client(); await owner.create();
  let cursorWrites = 0, deletes = 0; const prepare = f.DB.prepare.bind(f.DB);
  f.DB.prepare = sql => { if (sql.startsWith("UPDATE link_participants_v2 SET offered_cursor")) cursorWrites++; if (sql.startsWith("DELETE")) deletes++; return prepare(sql); };
  await owner.receive({ waitMs: 0 }); await owner.receive({ waitMs: 0 });
  assert.equal(cursorWrites, 0); assert.equal(deletes, 0);
});

test("client rejects invalid waits before any request", async t => {
  const f = fixture(t), owner = f.client();
  for (const waitMs of [-1, 25001, 1.5, NaN]) await assert.rejects(owner.receive({ waitMs }), { code: "INVALID_INPUT" });
  assert.equal(f.calls.length, 0);
});
