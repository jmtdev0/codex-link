import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createDurableLink } from "../worker/link-v2.js";
import { createLinkClient } from "../worker/link-client.js";
import { TestD1 } from "./support/d1.mjs";

function fixture(t, intercept = undefined) {
  let clock = Date.now();
  const DB = new TestD1(), env = { DB, LINK_GATEWAY_MASTER_KEY: randomBytes(32).toString("base64url") };
  const service = () => createDurableLink({ now: () => clock, pollMs: 5, maxCreates: 100, maxRequests: 10000, maxIngress: 10000 });
  let server = service(); t.after(() => DB.close());
  const wire = async (url, init = {}) => {
    assert.equal(init.redirect, "error"); assert.equal(new URL(url).search, "");
    const response = await server.fetch(new Request(url, { ...init, headers: { ...init.headers, "cf-connecting-ip": "sdk-test" } }), env);
    return intercept ? intercept(url, init, response) : response;
  };
  const client = (extra = {}) => createLinkClient({ baseUrl: "https://link.test", consentToPlaintextGateway: true, fetch: wire, sleep: async () => {}, ...extra });
  return { DB, client, advance: ms => { clock += ms; }, restartServer: () => { server = service(); } };
}

test("join/send/receive hides receipts and resumes the same identity in a fresh client", async t => {
  const f = fixture(t), a = f.client(), room = await a.create({ name: "Agent A" });
  await a.send("Sent before B starts", { requestId: "first" });
  f.advance(8 * 60000); f.restartServer();
  const b = f.client(), joined = await b.join(room.invitation, { name: "Agent B" }), saved = b.exportSession();
  const batch = await b.receive({ waitMs: 0 });
  assert.equal(batch.messages[0].text, "Sent before B starts"); assert.equal(batch.receiptPending, false);
  assert.equal((await a.outbox("first")).recipients[0].state, "received-by-client");
  const resumed = f.client(saved); assert.equal((await resumed.resume()).participantId, joined.participantId);
  assert.equal((await resumed.receive({ waitMs: 0 })).messages.length, 0);
  await resumed.send("I am back", { requestId: "reply" });
  assert.equal((await a.receive({ waitMs: 0 })).messages[0].text, "I am back");
  assert.equal(f.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM link_participants_v2").get().n, 2);
});

test("lost setup and send responses retry the same credential and requestId without duplicates", async t => {
  let lostSetup = false, lostSend = false;
  const f = fixture(t, (url, init, response) => {
    if (url.endsWith("/rooms") && !lostSetup) { lostSetup = true; throw new TypeError("synthetic response loss"); }
    if (url.endsWith("/send") && !lostSend) { lostSend = true; throw new TypeError("synthetic response loss"); }
    return response;
  });
  const a = f.client(); const room = await a.create();
  assert.equal(typeof room.invitation, "string");
  assert.equal((await a.send("One accepted message", { requestId: "retry-once" })).accepted, true);
  assert.equal(f.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM link_rooms_v2").get().n, 1);
  assert.equal(f.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM link_messages_v2").get().n, 1);
});

test("an ambiguous accepted send is resolved through outbox rather than a new message", async t => {
  const f = fixture(t, (url, init, response) => { if (url.endsWith("/send")) throw new TypeError("synthetic send response loss"); return response; });
  const a = f.client(); await a.create();
  const result = await a.send("Still only one message", { requestId: "recover-outbox" });
  assert.equal(result.accepted, true); assert.equal(result.recovered, true);
  assert.equal(a.pendingSends().length, 0);
  assert.equal(f.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM link_messages_v2").get().n, 1);
});

test("a receipt failure never hides successfully fetched text or marks it read", async t => {
  let failConfirmation = true;
  const f = fixture(t, (url, init, response) => url.endsWith("/confirm") && failConfirmation ? new Response(JSON.stringify({ error: { code: "TEMPORARY", message: "Synthetic failure" } }), { status: 503 }) : response);
  const a = f.client(), room = await a.create(), b = f.client(); await b.join(room.invitation);
  await a.send("Keep the text despite receipt failure", { requestId: "receipt-failure" });
  const batch = await b.receive({ waitMs: 0 }); assert.equal(batch.messages.length, 1); assert.equal(batch.receiptPending, true);
  assert.notEqual((await a.outbox("receipt-failure")).recipients[0].state, "read-confirmed");
  failConfirmation = false; await b.markRead(batch.nextCursor);
  assert.equal((await a.outbox("receipt-failure")).recipients[0].state, "read-confirmed");
});

test("a wait can be cancelled without leaving or changing the participant identity", async t => {
  const f = fixture(t), a = f.client(); await a.create(); const saved = a.exportSession();
  const controller = new AbortController(); controller.abort();
  await assert.rejects(a.receive({ waitMs: 500, signal: controller.signal }), { code: "ABORTED" });
  const b = f.client(saved); assert.equal((await b.resume()).participantId, a.info().participantId);
});

test("consent is required for setup but not repeated on resume or every message", async t => {
  const f = fixture(t), noConsent = f.client({ consentToPlaintextGateway: false });
  await assert.rejects(noConsent.create(), { code: "CONSENT_REQUIRED" });
  const a = f.client(); await a.create();
  const resumed = f.client({ ...a.exportSession(), consentToPlaintextGateway: false });
  await resumed.resume(); assert.equal((await resumed.send("Consent was already stored", { requestId: "once" })).accepted, true);
  assert.equal(JSON.stringify(resumed).includes(a.exportSession().credential), false);
});

test("a host can save its credential before setup and recover after every setup response is lost", async t => {
  let saved, beforeRequest = false;
  const f = fixture(t, (url, init, response) => {
    if (url.endsWith("/rooms")) { assert.equal(beforeRequest, true); throw new TypeError("All setup responses lost"); }
    return response;
  });
  const a = f.client({ saveSession: async session => { saved = session; beforeRequest = true; } });
  await assert.rejects(a.create({ name: "Saved before setup" }));
  assert.ok(saved.credential.startsWith("lks2."));
  const fresh = f.client(saved), resumed = await fresh.resume();
  assert.equal(resumed.name, "Saved before setup");
  assert.equal(f.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM link_rooms_v2").get().n, 1);
});
