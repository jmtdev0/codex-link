import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createDurableLink } from "../worker/link-v2.js";
import { TestD1 } from "./support/d1.mjs";

const origin = "https://link.test";
const secret = () => "lks2." + randomBytes(32).toString("base64url");
function fixture(t, options = {}) {
  let clock = Date.now(), service = createDurableLink({ now: () => clock, maxCreates: 100, maxRequests: 10000, maxIngress: 10000, pollMs: 5, ...options });
  const DB = new TestD1(), env = { DB, LINK_GATEWAY_MASTER_KEY: randomBytes(32).toString("base64url") };
  t.after(() => DB.close());
  async function call(path, { credential, method = "GET", json, headers = {}, signal } = {}) {
    const response = await service.fetch(new Request(origin + "/link/v1" + path, { method, headers: { "cf-connecting-ip": "synthetic-test",
      ...(credential ? { authorization: "Bearer " + credential } : {}), ...(json !== undefined ? { "content-type": "application/json" } : {}), ...headers },
      ...(json === undefined ? {} : { body: JSON.stringify(json) }), ...(signal ? { signal } : {}) }), env);
    return { status: response.status, data: await response.json(), response };
  }
  async function create(extra = {}, credential = secret()) {
    const r = await call("/rooms", { credential, method: "POST", json: { name: "Owner", consentToPlaintextGateway: true, ...extra } });
    assert.equal(r.status, 201, JSON.stringify(r.data)); return { ...r.data, response: r.response };
  }
  async function join(room, extra = {}, credential = secret()) {
    const r = await call("/join", { credential, method: "POST", json: { invitation: room.invitation, name: "Peer", consentToPlaintextGateway: true, ...extra } });
    assert.equal(r.status, 201, JSON.stringify(r.data)); return r.data;
  }
  const send = (actor, text, requestId = randomBytes(8).toString("hex"), extra = {}) => call("/send", { credential: actor.credential, method: "POST", json: { text, requestId, ...extra } });
  const receive = (actor, json = {}, options = {}) => call("/receive", { credential: actor.credential, method: "POST", json, ...options });
  const confirm = (actor, cursor, read = false) => call("/confirm", { credential: actor.credential, method: "POST", json: { cursor, read } });
  return { DB, env, call, create, join, send, receive, confirm, advance: n => { clock += n; }, restart: () => { service = createDurableLink({ now: () => clock, maxCreates: 100, maxRequests: 10000, maxIngress: 10000, pollMs: 5, ...options }); } };
}

test("the durable participant resumes after service restart without another room slot", async t => {
  const f = fixture(t), owner = await f.create(), peer = await f.join(owner);
  f.restart();
  const resumed = await f.call("/session", { credential: peer.credential });
  assert.equal(resumed.status, 200); assert.equal(resumed.data.participantId, peer.participantId);
  assert.equal(resumed.data.expiresAt, owner.expiresAt);
  const repeated = await f.join(owner, {}, peer.credential);
  assert.equal(repeated.participantId, peer.participantId);
  assert.equal(f.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM link_participants_v2").get().n, 2);
});

test("messages sent before a peer joins survive more than five minutes and cursor ACKs", async t => {
  const f = fixture(t), owner = await f.create();
  const sent = await f.send(owner, "Durable synthetic message: á, ñ", "offline-1"); assert.equal(sent.status, 202);
  f.advance(7 * 60000); f.restart();
  const peer = await f.join(owner), inbox = await f.receive(peer);
  assert.equal(inbox.status, 200); assert.equal(inbox.data.messages[0].messageId, sent.data.messageId);
  assert.equal((await f.confirm(peer, inbox.data.nextCursor)).status, 200);
  assert.equal((await f.receive(peer)).data.messages.length, 0);
  assert.equal((await f.receive(peer, { cursor: 0 })).data.messages[0].text, "Durable synthetic message: á, ñ");
  assert.equal(f.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM link_messages_v2").get().n, 1);
});

test("idempotent setup and sends survive lost responses and reject changed retry bodies", async t => {
  const f = fixture(t), credential = secret(), room = await f.create({}, credential);
  const same = await f.create({}, credential); assert.equal(same.roomId, room.roomId); assert.equal(same.invitation, room.invitation);
  const changed = await f.call("/rooms", { method: "POST", credential, json: { name: "Changed", consentToPlaintextGateway: true } }); assert.equal(changed.status, 409);
  const accepted = await f.send(room, "Same content", "same-request"); f.restart();
  const retry = await f.send(room, "Same content", "same-request");
  assert.equal(retry.status, 202); assert.equal(retry.data.messageId, accepted.data.messageId); assert.equal(retry.data.duplicate, true);
  assert.equal((await f.send(room, "Different content", "same-request")).status, 409);
  assert.equal(f.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM link_rooms_v2").get().n, 1);
  assert.equal(f.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM link_messages_v2").get().n, 1);
});

test("a long receive does not hold a send lease, and the waiting peer gets the reply", async t => {
  const f = fixture(t), owner = await f.create(), peer = await f.join(owner);
  const pending = f.receive(peer, { waitMs: 500 });
  assert.equal((await f.send(peer, "Peer can still send while waiting", "parallel-peer")).status, 202);
  assert.equal((await f.send(owner, "Reply during the open wait", "parallel-owner")).status, 202);
  const received = await pending;
  assert.equal(received.status, 200); assert.equal(received.data.messages.some(m => m.text === "Reply during the open wait"), true);
  assert.equal(f.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM link_waiters_v2").get().n, 0);
});

test("outbox distinguishes accepted, client receipt and explicit read confirmation", async t => {
  const f = fixture(t), owner = await f.create(), peer = await f.join(owner);
  await f.send(owner, "Check receipts", "receipt-1");
  const outbox = () => f.call("/outbox/receipt-1", { credential: owner.credential });
  assert.equal((await outbox()).data.recipients[0].state, "queued");
  const batch = await f.receive(peer);
  assert.equal((await outbox()).data.recipients[0].state, "queued", "a server response is not a confirmed client receipt");
  await f.confirm(peer, batch.data.nextCursor);
  assert.equal((await outbox()).data.recipients[0].state, "received-by-client");
  await f.confirm(peer, batch.data.nextCursor, true);
  assert.equal((await outbox()).data.recipients[0].state, "read-confirmed");
  assert.equal((await f.call("/outbox/receipt-1", { credential: peer.credential })).status, 404);
});

test("room isolation, explicit consent, individual revocation and owner closure are enforced", async t => {
  const f = fixture(t), a = await f.create(), peer = await f.join(a), b = await f.create({ name: "Other owner" });
  assert.equal((await f.call("/join", { credential: secret(), method: "POST", json: { invitation: a.invitation, name: "No consent" } })).status, 400);
  assert.equal((await f.call("/join", { credential: peer.credential, method: "POST", json: { invitation: b.invitation, consentToPlaintextGateway: true } })).status, 409);
  const sent = await f.send(a, "Room A only", "private-a");
  assert.equal((await f.receive(b)).data.messages.length, 0);
  assert.equal((await f.send(b, "Bad reply", "wrong-room", { inReplyTo: sent.data.messageId })).status, 400);
  assert.equal((await f.call("/room", { credential: peer.credential, method: "DELETE" })).status, 403);
  assert.equal((await f.call("/session", { credential: peer.credential, method: "DELETE" })).status, 200);
  assert.equal((await f.receive(peer)).status, 410);
  assert.equal((await f.call("/room", { credential: a.credential, method: "DELETE" })).status, 200);
  assert.equal((await f.receive(a)).status, 410);
  assert.equal((await f.call("/room", { credential: a.credential, method: "DELETE" })).status, 200);
  assert.equal(f.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM link_messages_v2").get().n, 0);
});

test("absolute room expiry revokes access and removes durable content on subsequent activity", async t => {
  const f = fixture(t), owner = await f.create({ ttlMinutes: 1 }), peer = await f.join(owner);
  await f.send(owner, "Expires once", "expiry-1"); f.advance(60001);
  assert.ok([401, 410].includes((await f.receive(peer)).status));
  assert.equal(f.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM link_messages_v2").get().n, 0);
  assert.equal(f.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM link_deliveries_v2").get().n, 0);
});

test("stored messages, names, invitations and credentials do not appear in plaintext database rows", async t => {
  const f = fixture(t), owner = await f.create({ name: "PRIVATE_NAME_CANARY" });
  await f.send(owner, "PRIVATE_BODY_CANARY", "encrypted-1");
  const stored = ["link_rooms_v2", "link_participants_v2", "link_messages_v2"].map(table => JSON.stringify(f.DB.sqlite.prepare("SELECT * FROM " + table).all())).join("");
  for (const value of ["PRIVATE_NAME_CANARY", "PRIVATE_BODY_CANARY", owner.credential, owner.invitation]) assert.equal(stored.includes(value), false);
});

test("pagination, more than 32 sends, replay and concurrent duplicate sends keep a bounded ordered ledger", async t => {
  const f = fixture(t), owner = await f.create(), peer = await f.join(owner);
  const duplicate = await Promise.all([f.send(owner, "One concurrent message", "concurrent"), f.send(owner, "One concurrent message", "concurrent")]);
  assert.deepEqual(duplicate.map(r => r.status), [202, 202]); assert.equal(duplicate[0].data.messageId, duplicate[1].data.messageId);
  for (let i = 0; i < 55; i++) assert.equal((await f.send(owner, "Entry " + i, "entry-" + i)).status, 202);
  const a = await f.receive(peer), b = await f.receive(peer, { cursor: a.data.nextCursor });
  assert.equal(a.data.messages.length, 50); assert.equal(a.data.more, true); assert.equal(b.data.messages.length, 6); assert.equal(b.data.more, false);
  assert.equal(new Set([...a.data.messages, ...b.data.messages].map(m => m.messageId)).size, 56);
  assert.equal((await f.confirm(peer, b.data.nextCursor + 999)).status, 400);
});

test("browser cookies remain scoped and HttpOnly; cross-origin writes and foreign keys fail", async t => {
  const f = fixture(t), owner = await f.create();
  const setCookie = owner.response.headers.get("set-cookie"); assert.match(setCookie, /__Host-link-session-v2=/); assert.match(setCookie, /HttpOnly; Secure; SameSite=Strict/);
  const cookie = setCookie.split(";")[0];
  assert.equal((await f.call("/session", { headers: { cookie } })).status, 200);
  assert.equal((await f.call("/access", { method: "POST", json: {}, headers: { cookie } })).status, 403);
  assert.equal((await f.call("/access", { method: "POST", json: {}, headers: { cookie, origin } })).status, 200);
  assert.equal((await f.call("/session", { credential: owner.credential, headers: { origin: "https://evil.test" } })).status, 403);
  assert.equal((await f.call("/session", { credential: secret() })).status, 401);
});

test("messages arriving during page decoding remain after the returned cursor", async t => {
  const f = fixture(t), owner = await f.create(), peer = await f.join(owner);
  await f.send(owner, "First", "cursor-first");
  const prepare = f.DB.prepare.bind(f.DB); let inject = true;
  f.DB.prepare = sql => {
    const statement = prepare(sql);
    if (!sql.startsWith("SELECT * FROM link_messages_v2 WHERE room_id = ? AND sequence > ?")) return statement;
    const originalBind = statement.bind;
    statement.bind = (...values) => {
      const bound = originalBind(...values), originalAll = bound.all;
      bound.all = async () => { const result = originalAll(); if (inject) { inject = false; await f.send(owner, "Arrived mid-page", "cursor-second"); } return result; };
      return bound;
    };
    return statement;
  };
  const first = await f.receive(peer); assert.equal(first.data.nextCursor, 1); assert.equal(first.data.messages.length, 1);
  const second = await f.receive(peer, { cursor: first.data.nextCursor });
  assert.equal(second.data.messages[0].text, "Arrived mid-page"); assert.equal(second.data.nextCursor, 2);
});

test("room-local sequence numbers do not expose other rooms' activity", async t => {
  const f = fixture(t), a = await f.create(), b = await f.create();
  assert.equal((await f.send(a, "A1", "a1")).data.sequence, 1);
  assert.equal((await f.send(a, "A2", "a2")).data.sequence, 2);
  assert.equal((await f.send(b, "B1", "b1")).data.sequence, 1);
});

test("storage bounds reject new sends without dropping or rejecting an accepted retry", async t => {
  const f = fixture(t), owner = await f.create();
  for (let i = 0; i < 512; i++) assert.equal((await f.send(owner, "Bounded", "cap-" + i)).status, 202);
  assert.equal((await f.send(owner, "One too many", "over-cap")).status, 429);
  assert.equal((await f.send(owner, "Bounded", "cap-0")).status, 202);
  assert.equal(f.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM link_messages_v2").get().n, 512);
  const other = await f.create(); const text = "a".repeat(8192);
  for (let i = 0; i < 128; i++) assert.equal((await f.send(other, text, "bytes-" + i)).status, 202);
  assert.equal((await f.send(other, "Full", "bytes-over")).status, 429);
  assert.equal((await f.send(other, "ñ".repeat(4097), "too-many-utf8-bytes")).status, 400);
});

test("membership and waiter caps are hard server-side bounds, independent of SDK behavior", async t => {
  const f = fixture(t), owner = await f.create();
  for (let i = 0; i < 7; i++) await f.join(owner, { name: "Member " + i });
  const ninth = await f.call("/join", { method: "POST", credential: secret(), json: { invitation: owner.invitation, consentToPlaintextGateway: true } });
  assert.equal(ninth.status, 429);
  const first = f.receive(owner, { waitMs: 100 }), second = f.receive(owner, { waitMs: 100 });
  // Allow both async requests to reach their durable waiter reservation.
  for (let n = 0; n < 100 && f.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM link_waiters_v2").get().n < 2; n++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal((await f.receive(owner, { waitMs: 100 })).status, 429);
  await Promise.all([first, second]);
  assert.equal(f.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM link_waiters_v2").get().n, 0);
});

test("revocation interrupts an outstanding wait without blocking the revoke request", async t => {
  const f = fixture(t), owner = await f.create(), peer = await f.join(owner);
  const pending = f.receive(peer, { waitMs: 500 });
  assert.equal((await f.call("/session", { method: "DELETE", credential: peer.credential })).status, 200);
  assert.equal((await pending).status, 410);
  assert.equal(f.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM link_waiters_v2").get().n, 0);
});

test("expiry during decryption is checked again before any message response", async t => {
  const f = fixture(t), owner = await f.create({ ttlMinutes: 1 }), peer = await f.join(owner);
  await f.send(owner, "Must not leak after expiry", "mid-expiry");
  const prepare = f.DB.prepare.bind(f.DB); let expire = true;
  f.DB.prepare = sql => {
    const statement = prepare(sql);
    if (!sql.startsWith("UPDATE link_participants_v2 SET offered_cursor")) return statement;
    const originalBind = statement.bind;
    statement.bind = (...values) => { const bound = originalBind(...values), originalRun = bound.run;
      bound.run = () => { const result = originalRun(); if (expire) { expire = false; f.advance(60001); } return result; }; return bound; };
    return statement;
  };
  const result = await f.receive(peer); assert.equal(result.status, 410); assert.equal(result.data.messages, undefined);
});
