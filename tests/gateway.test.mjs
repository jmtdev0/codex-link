import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import test, { after, before } from "node:test";
import { createGateway, RELAY, VERSION } from "../gateway/worker/index.js";
import { LinkClient } from "../link/client.mjs";
import {
  createControlProof, createIdentity, createInvitation, decryptMessagePayload,
  deriveRoomCapability, encryptMessage, parseInvitation, randomId, verifyControlProof,
} from "../plugin/src/protocol.mjs";
import { createD1TestDatabase, sqliteAvailable as relaySqliteAvailable } from "./support/d1-test-db.mjs";
import { mountSitesRelay } from "./support/link-test-clients.mjs";
import { createGatewayTestDatabase, sqliteAvailable } from "./support/gateway-test-db.mjs";

const GATEWAY = "https://gateway.example.test";
const IP = "192.0.2.41";
const RECEIPT = "[[codex-link-receipt:v1]]";
const nativeFetch = globalThis.fetch;
const localOrigins = new Set();

// Even SDK traffic is fail-closed: only this file's mounted loopback servers can
// be reached. Redirects cannot turn a local request into external traffic.
before(() => {
  globalThis.fetch = (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" ||
        !localOrigins.has(url.origin) || url.username || url.password) {
      throw new Error("Offline gateway tests blocked a non-local fetch.");
    }
    return nativeFetch(input, { ...init, redirect: "error" });
  };
});
after(() => { globalThis.fetch = nativeFetch; });

function gatewayTest(name, fn) {
  return test(name, { skip: !sqliteAvailable || !relaySqliteAvailable, timeout: 15_000 }, fn);
}

// Never let assertion diffs print generated invitations, keys, or capsules.
function samePrivate(actual, expected, message = "Private values must match (redacted).") {
  assert.equal(actual === expected, true, message);
}
function sameJsonPrivate(actual, expected, message) {
  samePrivate(JSON.stringify(actual), JSON.stringify(expected), message);
}
function expect(result, status = 200, code) {
  assert.equal(result.status, status, "Gateway HTTP status");
  if (code) assert.equal(result.value?.error?.code, code);
  assert.equal(result.headers.get("cache-control"), "no-store");
  assert.equal(result.headers.get("referrer-policy"), "no-referrer");
  assert.equal(result.headers.get("x-content-type-options"), "nosniff");
  assert.equal(result.headers.get("x-frame-options"), "DENY");
  assert.equal(result.headers.get("vary"), "authorization");
  assert.equal(result.headers.has("access-control-allow-origin"), false);
  return result.value;
}
const key = () => randomBytes(32).toString("base64url");
const hash = value => createHash("sha256").update(value).digest("base64url");

// Independent Node crypto is used only to inspect/perturb synthetic test state.
// The interoperability assertions use the canonical, unchanged plugin protocol.
function openTestSeal(secret, value, aad) {
  const [nonce, encrypted] = value.split(".").map(part => Buffer.from(part, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(secret, "base64url"), nonce);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(encrypted.subarray(-16));
  return JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]).toString("utf8"));
}
function sealTestValue(secret, value, aad) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(secret, "base64url"), nonce);
  cipher.setAAD(Buffer.from(aad));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final(), cipher.getAuthTag()]);
  return `${nonce.toString("base64url")}.${encrypted.toString("base64url")}`;
}
function alterEncoding(value) {
  const bytes = Buffer.from(value, "base64url");
  bytes[0] ^= 1;
  return bytes.toString("base64url");
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function reached(gate) {
  let timer;
  try {
    await Promise.race([gate.promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Local test synchronization point was not reached.")), 3_000);
    })]);
  } finally { clearTimeout(timer); }
}

// Pause or fail a single D1 operation without changing SQL, the migration, or
// the Worker. Batch still executes the underlying bound statements atomically.
function interceptDatabase(db, intercept) {
  const original = Symbol("underlying test D1 statement");
  return {
    prepare(sql) {
      function bound(values = []) {
        const statement = db.prepare(sql).bind(...values);
        const invoke = (method, args) => intercept({ sql, values, method, execute: () => statement[method](...args) });
        return {
          [original]: statement,
          bind(...values) { return bound(values); },
          first(...args) { return invoke("first", args); },
          all(...args) { return invoke("all", args); },
          run(...args) { return invoke("run", args); },
        };
      }
      return bound();
    },
    batch(statements) { return db.batch(statements.map(statement => statement[original])); },
  };
}

async function fixture(t, options = {}) {
  const db = await createGatewayTestDatabase();
  const relayDb = await createD1TestDatabase();
  let relay;
  let owner;
  const gates = [];
  t.after(async () => {
    for (const gate of gates) gate.resolve();
    owner?.dispose();
    if (relay) {
      await relay.close();
      localOrigins.delete(relay.baseUrl);
    }
    relayDb.close();
    db.close();
  });
  relay = await mountSitesRelay(relayDb);
  localOrigins.add(relay.baseUrl);
  owner = new LinkClient({ relayUrl: relay.baseUrl });
  const room = await owner.createRoom({ displayName: "SDK owner" });
  const invitation = parseInvitation(room.invitationCode);
  const env = { DB: db, LINK_GATEWAY_MASTER_KEY: key() };
  const clock = { value: Date.now() };
  const calls = [];
  const faults = [];
  const fetchRelay = async (input, init = {}) => {
    const url = new URL(input);
    if (url.origin !== RELAY || url.username || url.password || url.hash ||
        !/^\/v1\/rooms\/[A-Za-z0-9_-]{22}\/(join|status|messages|acks|leave)$/.test(url.pathname)) {
      throw new Error("Gateway tried to use a non-fixed relay target.");
    }
    assert.equal(init.redirect, "manual", "Upstream redirects must be inspected without following them.");
    assert.equal(new Headers(init.headers).get("accept"), "application/json");
    const call = { url, method: init.method, body: init.body, headers: new Headers(init.headers) };
    calls.push(call);
    const forward = () => fetch(`${relay.baseUrl}${url.pathname}${url.search}`, init);
    const index = faults.findIndex(fault => fault.match(call));
    return index < 0 ? forward() : faults.splice(index, 1)[0].handle(call, forward);
  };
  const worker = (overrides = {}) => createGateway({ ...options, ...overrides, now: () => clock.value, fetchRelay });
  const current = worker();
  async function call(path, { method = "GET", credential, body, rawBody, headers: extraHeaders = {},
    worker: selected = current, env: selectedEnv = env, origin = GATEWAY } = {}) {
    const headers = new Headers({ "cf-connecting-ip": IP });
    if (credential !== undefined) headers.set("authorization", `Bearer ${credential}`);
    if (body !== undefined || rawBody !== undefined) headers.set("content-type", "application/json");
    for (const [name, value] of Object.entries(extraHeaders)) {
      if (value === null) headers.delete(name); else headers.set(name, value);
    }
    const payload = rawBody !== undefined ? rawBody : body !== undefined ? JSON.stringify(body) : undefined;
    const request = new Request(`${origin}${path}`, {
      method, headers, ...(payload !== undefined ? { body: payload } : {}),
      ...(payload instanceof ReadableStream ? { duplex: "half" } : {}),
    });
    const response = await selected.fetch(request, selectedEnv);
    const value = await response.json();
    return { status: response.status, headers: response.headers, value };
  }
  const provisionBody = (changes = {}) => ({
    invitationCode: room.invitationCode, consentToPlaintextGateway: true, provisioningKey: key(), ...changes,
  });
  const provision = (body = provisionBody(), config = {}) => call("/bridge/v1/sessions", { method: "POST", body, ...config });
  const send = (session, body, config = {}) => call("/bridge/v1/messages", { method: "POST", credential: session.credential, body, ...config });
  const receive = (session, config = {}) => call("/bridge/v1/receive", { method: "POST", credential: session.credential, body: {}, ...config });
  const ack = (session, messageIds, config = {}) => call("/bridge/v1/acks", { method: "POST", credential: session.credential, body: { messageIds }, ...config });
  const status = (session, config = {}) => call("/bridge/v1/status", { credential: session.credential, ...config });
  const row = session => db.sqlite.prepare("SELECT * FROM link_gateway_sessions WHERE session_id = ?").get(session.sessionId);
  const ticket = session => openTestSeal(env.LINK_GATEWAY_MASTER_KEY, session.credential.slice(5), "link-gateway/capsule/v1");
  const state = session => openTestSeal(ticket(session).stateKey, row(session).state_ciphertext, `link-gateway/state/v1|${session.sessionId}`);
  const setState = (session, value) => db.sqlite.prepare("UPDATE link_gateway_sessions SET state_ciphertext = ? WHERE session_id = ?")
    .run(sealTestValue(ticket(session).stateKey, value, `link-gateway/state/v1|${session.sessionId}`), session.sessionId);
  const once = (method, action, handle, predicate = () => true) => faults.push({
    match: call => call.method === method && call.url.pathname.endsWith(`/${action}`) && predicate(call), handle,
  });
  const gate = () => { const result = deferred(); gates.push(result); return result; };
  const queued = (participantId, messageId) => relayDb.sqlite.prepare(
    "SELECT COUNT(*) AS count FROM codex_link_messages WHERE recipient_id = ? AND message_id = ?",
  ).get(participantId, messageId).count;
  async function rawPeer() {
    const identity = createIdentity();
    const body = { participantId: identity.participantId, protocolVersion: 2, publicKey: identity.publicKey };
    body.controlProof = createControlProof("join", invitation.roomId, body, identity);
    const headers = { authorization: `Bearer ${deriveRoomCapability(invitation)}`, "content-type": "application/json" };
    const response = await fetch(`${relay.baseUrl}/v1/rooms/${invitation.roomId}/join`, { method: "POST", headers, body: JSON.stringify(body) });
    assert.equal(response.status, 200, "Canonical peer joined the local relay.");
    await response.arrayBuffer();
    return {
      identity,
      envelope: (text, values = {}) => encryptMessage(invitation, identity.participantId, text, identity, values),
      async post(envelope) {
        const response = await fetch(`${relay.baseUrl}/v1/rooms/${invitation.roomId}/messages`, { method: "POST", headers, body: JSON.stringify(envelope) });
        assert.equal(response.status, 202, "Canonical peer sent to the local relay.");
        await response.arrayBuffer();
      },
    };
  }
  return { db, relayDb, relay, owner, room, invitation, env, clock, calls, worker, call, provisionBody,
    provision, send, receive, ack, status, row, ticket, state, setState, once, gate, queued, rawPeer };
}

const loseAfter = async (_call, forward) => {
  await (await forward()).arrayBuffer();
  throw new Error("Synthetic lost upstream response.");
};
const failBefore = async () => { throw new Error("Synthetic upstream outage."); };

gatewayTest("gateway D1 adapter uses its own migration, bind/first/RETURNING and atomic batch rollback", async t => {
  const db = await createGatewayTestDatabase();
  t.after(() => db.close());
  const insert = db.prepare("INSERT INTO link_gateway_limits VALUES (?, ?, ?)");
  assert.equal(insert.bind("adapter-only", 1, 1).run().meta.changes, 1);
  assert.equal(db.prepare("SELECT request_count FROM link_gateway_limits WHERE bucket_key = ?").bind("adapter-only").first("request_count"), 1);
  assert.equal(db.prepare("SELECT * FROM link_gateway_limits WHERE bucket_key = ?").bind("missing").first(), null);
  assert.equal(db.prepare("UPDATE link_gateway_limits SET request_count = request_count + 1 RETURNING request_count").first().request_count, 2);
  assert.throws(() => db.batch([insert.bind("rolled-back", 1, 1), insert.bind("adapter-only", 1, 1)]), /UNIQUE constraint failed/);
  assert.equal(db.prepare("SELECT * FROM link_gateway_limits WHERE bucket_key = ?").bind("rolled-back").first(), null);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'codex_link_%'").all().results.length, 0);
});

gatewayTest("trusted gateway advertises 0.9.0 and retains the existing 0.7.1 plugin", async t => {
  const f = await fixture(t);
  assert.equal(VERSION, "0.9.0");
  assert.equal(RELAY, "https://codex-link-relay.sarda0x.chatgpt.site");
  const plugin = JSON.parse(await readFile(new URL("../plugin/.codex-plugin/plugin.json", import.meta.url), "utf8"));
  assert.equal(plugin.version, "0.7.1");
  const health = expect(await f.call("/health"));
  assert.equal(health.version, "0.9.0");
  assert.equal(health.gatewayCanReadPlaintext, true);
  const session = expect(await f.provision(), 201);
  assert.equal(/^lgw1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(session.credential), true, "Sealed bearer format (redacted).");
  assert.equal(session.mode, "trusted-https-gateway");
  assert.equal(session.gatewayCanReadPlaintext, true);
  assert.equal(session.vaultOnly, true);
  assert.equal(session.apiBase, `${GATEWAY}/bridge/v1`);
  assert.equal(Object.hasOwn(session, "invitationCode"), false);
  assert.equal(Object.hasOwn(session, "privateKey"), false);
  const status = expect(await f.status(session));
  assert.equal(status.version, "0.9.0");
  assert.equal(status.participantCount, 2);
  assert.equal(status.pendingMessages, 0);
});

gatewayTest("SDK and WebCrypto gateway interoperate bidirectionally with signed v2 envelopes and controls", async t => {
  const f = await fixture(t);
  const session = expect(await f.provision(f.provisionBody({ displayName: "  Jose\u0301 (HTTPS)  " })), 201);
  const sent = await f.owner.send(f.room.sessionId, { text: "SDK to HTTPS: á, ñ, 🔐", requestId: "sdk-to-gateway" });
  const incoming = expect(await f.receive(session));
  assert.equal(incoming.messages.length, 1);
  const message = incoming.messages[0];
  samePrivate(message.messageId, sent.messageId);
  samePrivate(message.participantId, f.room.participantId);
  assert.equal(message.text, "SDK to HTTPS: á, ñ, 🔐");
  assert.equal(message.displayName, "SDK owner");
  assert.equal(message.untrusted, true);
  assert.equal(incoming.untrusted, true);
  assert.equal(f.queued(session.participantId, sent.messageId), 1, "Receive alone must not acknowledge the application inbox.");

  const outgoing = expect(await f.send(session, { text: "HTTPS to SDK: résumé", requestId: "gateway-to-sdk", messageType: "agent_reply", inReplyTo: sent.messageId }), 202);
  const onOwner = await f.owner.receive(f.room.sessionId);
  assert.equal(onOwner.messages.length, 1);
  assert.equal(onOwner.messages[0].text, "HTTPS to SDK: résumé");
  assert.equal(onOwner.messages[0].messageType, "agent_reply");
  assert.equal(onOwner.messages[0].displayName, "José (HTTPS)");
  samePrivate(onOwner.messages[0].inReplyTo, sent.messageId);
  assert.equal(onOwner.messages[0].untrusted, true);
  assert.equal(onOwner.deliveryReceipts.length, 1);
  samePrivate(onOwner.deliveryReceipts[0].messageId, sent.messageId);

  const post = f.calls.find(call => call.method === "POST" && call.url.pathname.endsWith("/messages") && JSON.parse(call.body).messageId === outgoing.messageId);
  const payload = decryptMessagePayload(f.invitation, JSON.parse(post.body));
  assert.equal(payload.text, "HTTPS to SDK: résumé");
  assert.equal(payload.messageType, "agent_reply");
  samePrivate(post.headers.get("authorization"), `Bearer ${deriveRoomCapability(f.invitation)}`);
  for (const call of f.calls.filter(call => ["join", "acks", "leave"].some(action => call.url.pathname.endsWith(`/${action}`)))) {
    const body = JSON.parse(call.body);
    assert.equal(verifyControlProof(call.url.pathname.split("/").at(-1), f.invitation.roomId, body, f.ticket(session).identity.publicKey), true);
  }
  const receipts = expect(await f.receive(session));
  assert.equal(receipts.deliveryReceipts.length, 1);
  samePrivate(receipts.deliveryReceipts[0].messageId, outgoing.messageId);
  expect(await f.ack(session, [sent.messageId]));
  assert.equal(expect(await f.receive(session)).messages.length, 0);
});

gatewayTest("independent Worker instances share D1 but keep conversation identities and request IDs separate", async t => {
  const f = await fixture(t);
  const a = expect(await f.provision(), 201);
  const b = expect(await f.provision(f.provisionBody(), { worker: f.worker() }), 201);
  assert.equal(a.sessionId === b.sessionId, false);
  assert.equal(a.participantId === b.participantId, false);
  const body = { text: "Same request ID, separate conversations", requestId: "shared-id" };
  const sentA = expect(await f.send(a, body, { worker: f.worker() }), 202);
  const sentB = expect(await f.send(b, body, { worker: f.worker() }), 202);
  assert.equal(sentA.messageId === sentB.messageId, false);
  const repeated = expect(await f.send(a, body, { worker: f.worker() }), 202);
  samePrivate(repeated.messageId, sentA.messageId);
  assert.equal(repeated.duplicate, true);
  assert.equal(expect(await f.status(a, { worker: f.worker() })).outgoingRequests, 1);
  assert.equal(expect(await f.status(b, { worker: f.worker() })).outgoingRequests, 1);
  const received = await f.owner.receive(f.room.sessionId);
  assert.equal(received.messages.length, 2);
  assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS count FROM link_gateway_sessions").get().count, 2);
});

gatewayTest("D1 stores only hashes and encrypted recovery/state, without plaintext or key material", async t => {
  const f = await fixture(t);
  const body = f.provisionBody({ displayName: "Synthetic private label" });
  const session = expect(await f.provision(body), 201);
  const initial = f.row(session).state_ciphertext;
  const outbound = "Synthetic outbound plaintext not for D1";
  const inbound = "Synthetic inbound plaintext not for D1";
  expect(await f.send(session, { text: outbound, requestId: "storage-check" }), 202);
  await f.owner.send(f.room.sessionId, { text: inbound, requestId: "storage-inbound" });
  expect(await f.receive(session));
  const ticket = f.ticket(session);
  const stored = JSON.stringify({
    sessions: f.db.sqlite.prepare("SELECT * FROM link_gateway_sessions").all(),
    limits: f.db.sqlite.prepare("SELECT * FROM link_gateway_limits").all(),
    relay: f.relayDb.sqlite.prepare("SELECT * FROM codex_link_messages").all(),
  });
  for (const value of [outbound, inbound, body.displayName, IP, body.invitationCode, f.invitation.secret,
    body.provisioningKey, session.credential, f.env.LINK_GATEWAY_MASTER_KEY, ticket.stateKey, ticket.identity.privateKey]) {
    assert.equal(stored.includes(value), false, "Persisted data must not contain test plaintext or credentials (redacted).");
  }
  const row = f.row(session);
  samePrivate(row.token_hash, hash(session.credential));
  samePrivate(row.provision_hash, hash(body.provisioningKey));
  assert.equal(initial === row.state_ciphertext, false);
  assert.equal(typeof row.state_ciphertext, "string");
  assert.equal(typeof row.provision_ciphertext, "string");
  assert.equal(f.state(session).inbox[0].text, inbound);
  const recovery = openTestSeal(body.provisioningKey, row.provision_ciphertext, `link-gateway/provision/v1|${hash(body.provisioningKey)}`);
  samePrivate(recovery.result.credential, session.credential);
  assert.throws(() => openTestSeal(key(), row.state_ciphertext, `link-gateway/state/v1|${session.sessionId}`), /authenticate|authentication/i);
});

gatewayTest("lost relay join and lost provisioning response recover the same identity and capsule across Workers", async t => {
  const f = await fixture(t);
  const body = f.provisionBody({ displayName: "Recovery test", ttlMinutes: 30 });
  f.once("POST", "join", loseAfter);
  expect(await f.provision(body), 502, "RELAY_UNAVAILABLE");
  const pending = f.db.sqlite.prepare("SELECT * FROM link_gateway_sessions").get();
  assert.equal(pending.state_ciphertext, null);
  assert.equal(pending.lease_until, 0);
  assert.equal(f.relayDb.sqlite.prepare("SELECT COUNT(*) AS count FROM codex_link_room_members").get().count, 2);
  const joinedIdentity = JSON.parse(f.calls[0].body).participantId;
  // This successful response is deliberately treated as lost by the caller.
  const lost = expect(await f.provision(body, { worker: f.worker() }), 201);
  samePrivate(lost.participantId, joinedIdentity);
  const countBeforeRetry = f.calls.length;
  const retry = expect(await f.provision(body, { worker: f.worker() }), 201);
  sameJsonPrivate(retry, lost, "A lost provisioning response must recover the identical capsule (redacted).");
  assert.equal(f.calls.length, countBeforeRetry, "Completed provisioning recovery must not rejoin.");
  assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS count FROM link_gateway_sessions").get().count, 1);
  assert.equal(f.relayDb.sqlite.prepare("SELECT COUNT(*) AS count FROM codex_link_room_members").get().count, 2);
  assert.equal(f.calls.filter(call => call.url.pathname.endsWith("/join")).every(call => JSON.parse(call.body).participantId === joinedIdentity), true);
});

gatewayTest("provisioning recovery is field/audience-bound, normalized, and expires after five minutes", async t => {
  const f = await fixture(t, { maxCreates: 30 });
  const body = f.provisionBody({ displayName: "  Jose\u0301  ", ttlMinutes: 20 });
  const session = expect(await f.provision(body), 201);
  sameJsonPrivate(expect(await f.provision({ ...body, displayName: "José" }), 201), session);
  for (const change of [{ displayName: "Different" }, { ttlMinutes: 21 }, { invitationCode: createInvitation().code }]) {
    expect(await f.provision({ ...body, ...change }), 409, "PROVISION_CONFLICT");
  }
  expect(await f.provision(body, { origin: "https://other-gateway.example.test" }), 409, "PROVISION_CONFLICT");
  f.clock.value += 5 * 60_000;
  expect(await f.provision(body), 409, "PROVISION_CONFLICT");
  assert.equal(f.row(session).provision_ciphertext, null, "Expired recovery ciphertext is pruned.");
  expect(await f.status(session));
});

gatewayTest("lost send response retries the exact persisted envelope after recipient ACK and suppresses replay", async t => {
  const f = await fixture(t);
  const session = expect(await f.provision(), 201);
  const body = { text: "Ambiguous send; retry explicitly", requestId: "retry-exact" };
  f.once("POST", "messages", loseAfter);
  expect(await f.send(session, body), 502, "SEND_UNCONFIRMED");
  const firstEnvelope = JSON.parse(f.calls.find(call => call.method === "POST" && call.url.pathname.endsWith("/messages")).body);
  assert.equal(f.state(session).sends[0].accepted, false);
  const received = await f.owner.receive(f.room.sessionId);
  assert.equal(received.messages.length, 1);
  samePrivate(received.messages[0].messageId, firstEnvelope.messageId);
  await f.owner.acknowledge(f.room.sessionId, { messageIds: [firstEnvelope.messageId] });
  assert.equal(f.queued(f.room.participantId, firstEnvelope.messageId), 0);
  const retry = expect(await f.send(session, body, { worker: f.worker() }), 202);
  samePrivate(retry.messageId, firstEnvelope.messageId);
  const sends = f.calls.filter(call => call.method === "POST" && call.url.pathname.endsWith("/messages"));
  assert.equal(sends.length, 2, "There is no implicit upstream retry.");
  samePrivate(sends[0].body, sends[1].body, "Explicit retry must reuse every envelope byte (redacted).");
  assert.equal(f.queued(f.room.participantId, firstEnvelope.messageId), 1, "The relay can requeue an already-ACKed envelope.");
  const replay = await f.owner.receive(f.room.sessionId);
  assert.equal(replay.messages.length, 0);
  assert.equal(replay.rejectedCount, 1, "Recipient replay protection prevents redisplaying the replay.");
  const processReceipt = expect(await f.receive(session));
  assert.equal(processReceipt.deliveryReceipts.length, 1);
  const cached = expect(await f.send(session, body, { worker: f.worker() }), 202);
  assert.equal(cached.duplicate, true);
  assert.equal(cached.acknowledgedBy.includes(f.room.participantId), true);
  assert.equal(f.calls.filter(call => call.method === "POST" && call.url.pathname.endsWith("/messages")).length, 2);
  expect(await f.send(session, { ...body, text: "Changed content" }), 409, "REQUEST_ID_CONFLICT");
});

gatewayTest("explicit ACK retains the durable inbox through failed, lost, and idempotent ACK responses", async t => {
  const f = await fixture(t);
  const session = expect(await f.provision(), 201);
  const sent = await f.owner.send(f.room.sessionId, { text: "Retain until explicit ACK is confirmed", requestId: "ack-retain" });
  expect(await f.receive(session));
  const before = f.calls.filter(call => call.url.pathname.endsWith("/acks")).length;
  samePrivate(expect(await f.receive(session, { worker: f.worker() })).messages[0].messageId, sent.messageId);
  assert.equal(f.calls.filter(call => call.url.pathname.endsWith("/acks")).length, before);
  f.once("POST", "acks", failBefore);
  expect(await f.ack(session, [sent.messageId]), 502, "RELAY_UNAVAILABLE");
  assert.equal(f.queued(session.participantId, sent.messageId), 1);
  assert.equal(f.state(session).inbox.length, 1);
  f.once("POST", "acks", loseAfter);
  expect(await f.ack(session, [sent.messageId]), 502, "RELAY_UNAVAILABLE");
  assert.equal(f.queued(session.participantId, sent.messageId), 0);
  samePrivate(expect(await f.receive(session, { worker: f.worker() })).messages[0].messageId, sent.messageId);
  assert.equal(expect(await f.status(session)).pendingMessages, 1);
  assert.equal(expect(await f.ack(session, [sent.messageId, sent.messageId], { worker: f.worker() })).acknowledged, 1);
  assert.equal(expect(await f.receive(session)).messages.length, 0);
  assert.equal(expect(await f.ack(session, [sent.messageId])).acknowledged, 1);
});

gatewayTest("delayed pending provisioning snapshot cannot overwrite completed provisioning and conversation state", async t => {
  const f = await fixture(t);
  const body = f.provisionBody();
  f.once("POST", "join", loseAfter);
  expect(await f.provision(body), 502, "RELAY_UNAVAILABLE");
  const entered = f.gate();
  const release = f.gate();
  let delayOnce = true;
  const delayedDb = interceptDatabase(f.db, async operation => {
    const value = operation.execute();
    if (delayOnce && operation.method === "first" && /SELECT \* FROM link_gateway_sessions WHERE provision_hash = \?/.test(operation.sql)) {
      delayOnce = false;
      assert.equal(value.state_ciphertext, null, "The delayed request captured a pending row.");
      entered.resolve();
      await release.promise;
    }
    return value;
  });
  const delayed = f.provision(body, { worker: f.worker(), env: { ...f.env, DB: delayedDb } });
  await reached(entered);
  const completed = expect(await f.provision(body, { worker: f.worker() }), 201);
  const sentBody = { text: "Do not reset this completed conversation", requestId: "after-provision" };
  const sent = expect(await f.send(completed, sentBody, { worker: f.worker() }), 202);
  const inbound = await f.owner.send(f.room.sessionId, { text: "Nor its durable inbox", requestId: "provision-inbox" });
  expect(await f.receive(completed));
  const ciphertext = f.row(completed).state_ciphertext;
  const tokenHash = f.row(completed).token_hash;
  const callCount = f.calls.length;
  release.resolve();
  const recovered = expect(await delayed, 201);
  sameJsonPrivate(recovered, completed, "The delayed request must recover the existing capsule (redacted).");
  samePrivate(f.row(completed).token_hash, tokenHash);
  samePrivate(f.row(completed).state_ciphertext, ciphertext, "Delayed provisioning must not rewrite encrypted conversation state.");
  assert.equal(f.calls.length, callCount, "Recovery under the lease must not join again.");
  samePrivate(f.state(completed).sends[0].envelope.messageId, sent.messageId);
  samePrivate(f.state(completed).inbox[0].messageId, inbound.messageId);
  assert.equal(expect(await f.send(completed, sentBody, { worker: f.worker() }), 202).duplicate, true);
});

gatewayTest("revocation bypasses exhausted ingress/session quotas, a held lease and corrupt state, even if leave fails", async t => {
  const f = await fixture(t, { maxRequests: 1, maxIngress: 2 });
  const body = f.provisionBody();
  const session = expect(await f.provision(body), 201);
  expect(await f.status(session));
  expect(await f.status(session), 429, "RATE_LIMIT");
  expect(await f.status(session), 429, "RATE_LIMIT");
  const quotas = JSON.stringify(f.db.sqlite.prepare("SELECT * FROM link_gateway_limits ORDER BY bucket_key").all());
  f.db.sqlite.prepare("UPDATE link_gateway_sessions SET lease_nonce = ?, lease_until = ?, state_ciphertext = ? WHERE session_id = ?")
    .run(randomId(), f.clock.value + 60_000, "corrupt-state", session.sessionId);
  f.once("POST", "leave", () => {
    const row = f.row(session);
    assert.equal(row.revoked_at, f.clock.value, "Revoke commits before best-effort leave.");
    assert.equal(row.state_ciphertext, null);
    assert.equal(row.provision_ciphertext, null);
    assert.equal(row.lease_nonce, null);
    assert.equal(row.lease_until, 0);
    return failBefore();
  });
  const revoked = expect(await f.call("/bridge/v1/session", {
    method: "DELETE", credential: session.credential, worker: f.worker(), headers: { "cf-connecting-ip": null },
  }));
  assert.deepEqual(revoked, { revoked: true, roomLeft: false, roomClosed: false });
  samePrivate(JSON.stringify(f.db.sqlite.prepare("SELECT * FROM link_gateway_limits ORDER BY bucket_key").all()), quotas);
  expect(await f.status(session, { headers: { "cf-connecting-ip": "192.0.2.42" } }), 410, "SESSION_REVOKED");
  expect(await f.provision(body), 409, "PROVISION_CONFLICT");
  const repeated = expect(await f.call("/bridge/v1/session", { method: "DELETE", credential: session.credential, worker: f.worker() }));
  assert.equal(repeated.revoked, true);
  assert.equal(repeated.roomClosed, false);
  assert.equal((await f.owner.status(f.room.sessionId)).participantCount, 1, "Only the gateway member leaves; the owner's room remains open.");
});

gatewayTest("revocation fences an in-flight send's later state write without recalling an already-dispatched message", async t => {
  const f = await fixture(t);
  const session = expect(await f.provision(), 201);
  const entered = f.gate();
  const release = f.gate();
  f.once("POST", "messages", async (_call, forward) => {
    const response = await forward();
    const bytes = await response.arrayBuffer();
    entered.resolve();
    await release.promise;
    return new Response(bytes, { status: response.status, headers: response.headers });
  });
  const sending = f.send(session, { text: "Already dispatched before revocation", requestId: "revoke-inflight" });
  await reached(entered);
  assert.equal(f.row(session).lease_until > f.clock.value, true);
  const sentId = f.state(session).sends[0].envelope.messageId;
  const revoked = expect(await f.call("/bridge/v1/session", { method: "DELETE", credential: session.credential, worker: f.worker() }));
  assert.equal(revoked.revoked, true);
  assert.equal(revoked.roomClosed, false);
  release.resolve();
  expect(await sending, 409, "SESSION_BUSY");
  assert.equal(f.row(session).state_ciphertext, null, "A stale request cannot resurrect revoked state.");
  assert.equal(f.row(session).lease_nonce, null);
  assert.equal(f.queued(f.room.participantId, sentId), 1, "An upstream call already dispatched cannot be recalled.");
  assert.equal((await f.owner.receive(f.room.sessionId)).messages[0].text, "Already dispatched before revocation");
  expect(await f.status(session, { worker: f.worker() }), 410, "SESSION_REVOKED");
});

gatewayTest("missing/broken storage and master-key configuration fail closed without a relay call", async t => {
  const f = await fixture(t);
  const session = expect(await f.provision(), 201);
  const baseline = f.calls.length;
  for (const env of [
    {}, { LINK_GATEWAY_MASTER_KEY: key() }, { ...f.env, DB: {} }, { ...f.env, DB: { prepare() {} } },
    { ...f.env, LINK_GATEWAY_MASTER_KEY: undefined }, { ...f.env, LINK_GATEWAY_MASTER_KEY: "invalid" },
    { ...f.env, LINK_GATEWAY_MASTER_KEY: `${key()}=` },
  ]) {
    expect(await f.status(session, { env }), 503, "NOT_CONFIGURED");
    expect(await f.call("/bridge/v1/session", { method: "DELETE", credential: session.credential, env }), 503, "NOT_CONFIGURED");
  }
  const brokenDb = { prepare() { throw new Error(`Synthetic DB failure ${session.credential} ${f.room.invitationCode}`); }, batch() {} };
  const failure = await f.status(session, { env: { ...f.env, DB: brokenDb } });
  expect(failure, 503, "GATEWAY_UNAVAILABLE");
  for (const secret of [session.credential, f.room.invitationCode]) assert.equal(JSON.stringify(failure.value).includes(secret), false, "Exceptions must not reflect synthetic secrets.");
  const emptyDb = await createGatewayTestDatabase();
  t.after(() => emptyDb.close());
  expect(await f.status(session, { env: { ...f.env, DB: emptyDb } }), 410, "SESSION_REVOKED");
  assert.equal(f.calls.length, baseline);
});

gatewayTest("authentication rejects malformed/tampered capsules, wrong audience/key and unknown token hashes", async t => {
  const f = await fixture(t);
  const session = expect(await f.provision(), 201);
  const [prefix, nonce, encrypted] = session.credential.split(".");
  const badHeaders = [undefined, "Basic ignored", "Bearer ignored", `bearer ${session.credential}`, `Bearer ${session.credential} extra`,
    `Bearer ${session.credential}=`, `Bearer ${prefix}.${alterEncoding(nonce)}.${encrypted}`, `Bearer ${prefix}.${nonce}.${alterEncoding(encrypted)}`,
    `Bearer ${prefix}.AA.${encrypted}`, `Bearer ${prefix}.${nonce}.AA`, `Bearer lgw1.${"a".repeat(4100)}.AA`];
  const baseline = f.calls.length;
  for (const authorization of badHeaders) {
    const headers = authorization === undefined ? {} : { authorization };
    expect(await f.call("/bridge/v1/status", { headers }), 401, "UNAUTHORIZED");
    expect(await f.call("/bridge/v1/session", { method: "DELETE", headers }), 401, "UNAUTHORIZED");
  }
  expect(await f.status(session, { origin: "https://other-gateway.example.test" }), 401, "UNAUTHORIZED");
  expect(await f.call("/bridge/v1/session", { method: "DELETE", credential: session.credential, origin: "https://other-gateway.example.test" }), 401, "UNAUTHORIZED");
  expect(await f.status(session, { env: { ...f.env, LINK_GATEWAY_MASTER_KEY: key() } }), 401, "UNAUTHORIZED");
  for (const change of [{ v: 2 }, { audience: "https://elsewhere.example.test" }, { sessionId: "bad" }, { expiresAt: 1.5 }]) {
    const forged = `lgw1.${sealTestValue(f.env.LINK_GATEWAY_MASTER_KEY, { ...f.ticket(session), ...change }, "link-gateway/capsule/v1")}`;
    expect(await f.call("/bridge/v1/status", { credential: forged }), 401, "UNAUTHORIZED");
  }
  const rewrapped = `lgw1.${sealTestValue(f.env.LINK_GATEWAY_MASTER_KEY, f.ticket(session), "link-gateway/capsule/v1")}`;
  expect(await f.call("/bridge/v1/status", { credential: rewrapped }), 410, "SESSION_REVOKED");
  expect(await f.call("/bridge/v1/session", { method: "DELETE", credential: rewrapped }), 410, "SESSION_REVOKED");
  assert.equal(f.calls.length, baseline);
  expect(await f.status(session, { headers: { origin: GATEWAY } }));
});

gatewayTest("encrypted state is authenticated and bound to its session; corrupt or swapped ciphertext fails closed", async t => {
  const f = await fixture(t);
  const a = expect(await f.provision(), 201);
  const b = expect(await f.provision(), 201);
  const original = f.row(a).state_ciphertext;
  const baseline = f.calls.length;
  const update = f.db.sqlite.prepare("UPDATE link_gateway_sessions SET state_ciphertext = ? WHERE session_id = ?");
  for (const ciphertext of [f.row(b).state_ciphertext, "not-a-seal", `${original.split(".")[0]}.${alterEncoding(original.split(".")[1])}`]) {
    update.run(ciphertext, a.sessionId);
    expect(await f.receive(a), 503, "GATEWAY_UNAVAILABLE");
    assert.equal(f.row(a).lease_nonce, null, "Failure releases only the acquired lease.");
  }
  assert.equal(f.calls.length, baseline);
  update.run(original, a.sessionId);
  expect(await f.status(a));
});

gatewayTest("an ACK whose relay commit succeeds but D1 save fails still retains its inbox for an explicit retry", async t => {
  const f = await fixture(t);
  const session = expect(await f.provision(), 201);
  const sent = await f.owner.send(f.room.sessionId, { text: "ACK persistence failure", requestId: "ack-db-failure" });
  expect(await f.receive(session));
  const faultyDb = interceptDatabase(f.db, operation => {
    if (operation.method === "run" && /UPDATE link_gateway_sessions SET state_ciphertext =/.test(operation.sql)) {
      throw new Error(`Synthetic save failure ${session.credential}`);
    }
    return operation.execute();
  });
  const failure = await f.ack(session, [sent.messageId], { env: { ...f.env, DB: faultyDb } });
  expect(failure, 503, "GATEWAY_UNAVAILABLE");
  assert.equal(JSON.stringify(failure.value).includes(session.credential), false);
  assert.equal(f.queued(session.participantId, sent.messageId), 0);
  assert.equal(f.state(session).inbox.length, 1);
  samePrivate(expect(await f.receive(session, { worker: f.worker() })).messages[0].messageId, sent.messageId);
  expect(await f.ack(session, [sent.messageId]));
  assert.equal(f.state(session).inbox.length, 0);
});

gatewayTest("provisioning validates consent, canonical invitations/keys, labels, TTL and a strict field allowlist", async t => {
  const f = await fixture(t, { maxCreates: 100 });
  const valid = f.provisionBody();
  const invalidBodies = [
    null, [], "body", {}, { ...valid, invitationCode: undefined }, { ...valid, provisioningKey: undefined },
    { ...valid, invitationCode: createInvitation({ version: 1 }).code }, { ...valid, invitationCode: 123 },
    { ...valid, invitationCode: "https://169.254.169.254/latest/meta-data/" },
    { ...valid, invitationCode: `${valid.invitationCode}=` },
    ...["", null, 123, "a".repeat(43), `${key()}=`, randomBytes(31).toString("base64url")].map(provisioningKey => ({ ...valid, provisioningKey })),
    ...["", "   ", "x".repeat(33), "\u0000", "\u202eunsafe", "\u2066unsafe", "😀".repeat(33), 12].map(displayName => ({ ...valid, displayName })),
    ...[0, -1, 1441, 1.5, "1"].map(ttlMinutes => ({ ...valid, ttlMinutes })),
    ...["relayUrl", "fetchRelay", "url", "callbackUrl", "masterKey", "identity"].map(name => ({ ...valid, [name]: "https://attacker.invalid/" })),
  ];
  for (const body of invalidBodies) expect(await f.provision(body), 400, "INVALID_INPUT");
  for (const consentToPlaintextGateway of [false, "true", 1, null]) {
    expect(await f.provision({ ...valid, consentToPlaintextGateway }), 400, "CONSENT_REQUIRED");
  }
  expect(await f.provision({ ...valid, consentToPlaintextGateway: undefined }), 400, "INVALID_INPUT");
  expect(await f.provision(valid, { headers: { authorization: "Bearer ignored" } }), 400, "INVALID_INPUT");
  expect(await f.provision(valid, { headers: { "cf-connecting-ip": null } }), 503, "RATE_PROTECTION_UNAVAILABLE");
  expect(await f.provision(valid, { headers: { "cf-connecting-ip": "x".repeat(129) } }), 503, "RATE_PROTECTION_UNAVAILABLE");
  assert.equal(f.calls.length, 0);
  assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS count FROM link_gateway_sessions").get().count, 0);
  const accepted = expect(await f.provision({ ...valid, displayName: "😀".repeat(32), ttlMinutes: 1440 }), 201);
  assert.equal(f.ticket(accepted).displayName, "😀".repeat(32));
});

gatewayTest("gateway cannot spoof human/receipt messages, sender labels, reply targets or unsupported fields", async t => {
  const f = await fixture(t, { maxRequests: 150 });
  const session = expect(await f.provision(), 201);
  const sent = await f.owner.send(f.room.sessionId, { text: "Authenticated reply target", requestId: "reply-target" });
  expect(await f.receive(session));
  const valid = { text: "Agent response", requestId: "validated-send" };
  const baseline = f.calls.length;
  const invalidBodies = [
    null, [], {}, { text: valid.text }, { requestId: valid.requestId },
    ...[null, 1, "", "   ", "é".repeat(4096)].map(text => ({ ...valid, text })),
    ...["", "x".repeat(81), "bad id", "a/b", "ñ", 1].map(requestId => ({ ...valid, requestId })),
    ...["human", "receipt", "unknown", 1].map(messageType => ({ ...valid, messageType })),
    ...["agent_ack", "agent_progress", "agent_reply"].map(messageType => ({ ...valid, messageType })),
    { ...valid, text: `${RECEIPT}${sent.messageId}` }, { ...valid, text: RECEIPT },
    ...[randomId(), "bad", 3].map(inReplyTo => ({ ...valid, inReplyTo })),
    ...["senderId", "displayName", "publicKey", "signature", "participantId", "relayUrl", "url"].map(name => ({ ...valid, [name]: "https://attacker.invalid/" })),
  ];
  for (const body of invalidBodies) expect(await f.send(session, body), 400, "INVALID_INPUT");
  for (const body of [{ waitMs: 0 }, { relayUrl: "https://attacker.invalid/" }, null, []]) {
    expect(await f.receive(session, { body }), 400, "INVALID_INPUT");
  }
  for (const messageIds of [[], [randomId()], [1], Array.from({ length: 17 }, () => sent.messageId), "bad"]) {
    expect(await f.ack(session, messageIds), 400, "INVALID_INPUT");
  }
  assert.equal(f.calls.length, baseline, "Rejected input must never reach the relay.");
  for (const messageType of ["agent_ack", "agent_progress", "agent_reply"]) {
    expect(await f.send(session, { ...valid, requestId: messageType, messageType, inReplyTo: sent.messageId }), 202);
  }
  const onOwner = await f.owner.receive(f.room.sessionId);
  assert.equal(onOwner.messages.length, 3);
  assert.deepEqual(onOwner.messages.map(message => message.messageType).sort(), ["agent_ack", "agent_progress", "agent_reply"]);
  assert.equal(onOwner.messages.every(message => message.inReplyTo === sent.messageId && message.displayName === "HTTPS guest" && message.untrusted), true);
});

gatewayTest("HTTPS, Origin, query, fragment and route restrictions prevent URL-based credentials and relay overrides", async t => {
  const f = await fixture(t);
  const session = expect(await f.provision(), 201);
  const baseline = f.calls.length;
  expect(await f.status(session, { origin: "http://gateway.example.test" }), 400, "HTTPS_REQUIRED");
  for (const suffix of [`?credential=${session.credential}`, "?relayUrl=https://attacker.invalid", "#fragment"]) {
    expect(await f.call(`/bridge/v1/status${suffix}`, { credential: session.credential }), 400, "HTTPS_REQUIRED");
  }
  for (const origin of ["https://attacker.invalid", "null", "http://gateway.example.test", `${GATEWAY}.attacker.invalid`]) {
    expect(await f.status(session, { headers: { origin } }), 403, "ORIGIN_REJECTED");
    expect(await f.provision(f.provisionBody(), { headers: { origin } }), 403, "ORIGIN_REJECTED");
    expect(await f.call("/bridge/v1/session", { method: "DELETE", credential: session.credential, headers: { origin } }), 403, "ORIGIN_REJECTED");
  }
  for (const [path, method] of [["/bridge/v1/status", "POST"], ["/bridge/v1/messages", "GET"], ["/bridge/v1/receive", "PUT"],
    ["/bridge/v1/status", "OPTIONS"], ["/bridge/v1/session", "POST"], ["/v1/rooms", "POST"], ["/bridge/v1/proxy/https://attacker.invalid", "GET"]]) {
    expect(await f.call(path, { method, credential: session.credential }), 404, "NOT_FOUND");
  }
  // Native Request rejects URL userinfo itself; a shaped request also exercises
  // the Worker's independent check before parsing any body or touching D1.
  const userinfo = await f.worker().fetch({ url: "https://ignored:ignored@gateway.example.test/bridge/v1/status", method: "GET", headers: new Headers() }, f.env);
  expect({ status: userinfo.status, headers: userinfo.headers, value: await userinfo.json() }, 400, "HTTPS_REQUIRED");
  assert.equal(f.calls.length, baseline);
  expect(await f.status(session, { headers: { origin: GATEWAY, host: "attacker.invalid", "x-forwarded-host": "169.254.169.254", "x-forwarded-proto": "http" } }));
  expect(await f.send(session, { text: "https://169.254.169.254/latest/meta-data/ is message data", requestId: "url-is-data" }), 202);
  assert.equal(f.calls.every(call => call.url.origin === RELAY), true, "Only the fixed relay is ever redirected to loopback.");
});

gatewayTest("JSON body/media-type/UTF-8/stream limits are enforced without trusting Content-Length", async t => {
  const f = await fixture(t);
  const session = expect(await f.provision(), 201);
  for (const contentType of [null, "text/plain", "application/jsonp", "application/problem+json"]) {
    expect(await f.receive(session, { headers: { "content-type": contentType } }), 415, "JSON_REQUIRED");
  }
  for (const rawBody of ["", "{", "null", "[]", "1", new Uint8Array([0xff, 0xfe])]) {
    expect(await f.receive(session, { rawBody }), 400, "INVALID_INPUT");
  }
  expect(await f.call("/bridge/v1/receive", { method: "POST", credential: session.credential, headers: { "content-type": "application/json" } }), 400, "INVALID_INPUT");
  const baseline = f.calls.length;
  expect(await f.receive(session, { rawBody: " ".repeat(16 * 1024 + 1), headers: { "content-length": "1" } }), 413, "BODY_TOO_LARGE");
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(16 * 1024).fill(32)); controller.enqueue(new Uint8Array([32])); },
    cancel() { cancelled = true; },
  });
  expect(await f.receive(session, { rawBody: stream, headers: { "content-length": "1" } }), 413, "BODY_TOO_LARGE");
  assert.equal(cancelled, true);
  assert.equal(f.calls.length, baseline);
  expect(await f.receive(session, { rawBody: `${" ".repeat(16 * 1024 - 2)}{}`, headers: { "content-type": "Application/JSON; charset=utf-8" } }));
});

gatewayTest("the encrypted message payload's 8 KiB boundary includes normalized label and JSON overhead", async t => {
  const f = await fixture(t);
  const session = expect(await f.provision(), 201);
  const overhead = Buffer.byteLength(JSON.stringify({ type: "text", text: "", displayName: "HTTPS guest" }));
  const text = "x".repeat(8192 - overhead);
  const sent = expect(await f.send(session, { text, requestId: "max-payload" }), 202);
  const envelope = f.state(session).sends[0].envelope;
  assert.equal(Buffer.from(envelope.ciphertext, "base64url").length, 8192);
  samePrivate(decryptMessagePayload(f.invitation, envelope).text, text);
  expect(await f.send(session, { text: `${text}x`, requestId: "too-large" }), 400, "INVALID_INPUT");
  const retry = expect(await f.send(session, { text, requestId: "max-payload", messageType: "message" }), 202);
  samePrivate(retry.messageId, sent.messageId);
  assert.equal(retry.duplicate, true);
});

gatewayTest("TTL is capped by room expiry, expires at the exact boundary, and does not prevent explicit revocation", async t => {
  const f = await fixture(t);
  const started = f.clock.value;
  const roomExpiry = started + 90_000;
  f.relayDb.sqlite.prepare("UPDATE codex_link_rooms SET expires_at = ? WHERE room_id = ?").run(roomExpiry, f.room.roomId);
  const short = expect(await f.provision(f.provisionBody({ ttlMinutes: 1 })), 201);
  const capped = expect(await f.provision(f.provisionBody({ ttlMinutes: 1440 })), 201);
  assert.equal(Date.parse(short.expiresAt), started + 60_000);
  assert.equal(Date.parse(capped.expiresAt), roomExpiry);
  assert.equal(f.row(capped).expires_at, roomExpiry);
  f.clock.value = started + 59_999;
  expect(await f.status(short));
  f.clock.value += 1;
  const baseline = f.calls.length;
  expect(await f.status(short), 410, "SESSION_EXPIRED");
  expect(await f.send(short, { text: "Too late", requestId: "expired-send" }), 410, "SESSION_EXPIRED");
  assert.equal(f.calls.length, baseline);
  expect(await f.status(capped));
  f.clock.value = roomExpiry;
  expect(await f.status(capped), 410, "SESSION_EXPIRED");
  const revoked = expect(await f.call("/bridge/v1/session", { method: "DELETE", credential: capped.credential }));
  assert.equal(revoked.revoked, true, "A retained expired row can still be explicitly revoked.");
  assert.equal(f.row(capped).state_ciphertext, null);
});

gatewayTest("the default four-create IP quota counts invalid attempts, is shared across Workers and resets after ten minutes", async t => {
  const f = await fixture(t);
  const invalid = f.provisionBody({ consentToPlaintextGateway: false });
  for (let index = 0; index < 4; index++) expect(await f.provision(invalid, { worker: f.worker() }), 400, "CONSENT_REQUIRED");
  expect(await f.provision(), 429, "RATE_LIMIT");
  assert.equal(f.calls.length, 0);
  expect(await f.provision(f.provisionBody(), { headers: { "cf-connecting-ip": "192.0.2.42" } }), 201);
  f.clock.value += 10 * 60_000;
  expect(await f.provision(f.provisionBody(), { worker: f.worker() }), 201);
});

gatewayTest("shared ingress quota is consumed before authentication and resets at the one-minute boundary", async t => {
  const f = await fixture(t, { maxIngress: 2 });
  for (let index = 0; index < 2; index++) expect(await f.call("/bridge/v1/status", { worker: f.worker() }), 401, "UNAUTHORIZED");
  expect(await f.call("/bridge/v1/status", { worker: f.worker() }), 429, "RATE_LIMIT");
  expect(await f.call("/bridge/v1/status", { headers: { "cf-connecting-ip": "192.0.2.42" } }), 401, "UNAUTHORIZED");
  expect(await f.call("/bridge/v1/status", { headers: { "cf-connecting-ip": null } }), 503, "RATE_PROTECTION_UNAVAILABLE");
  f.clock.value += 60_000;
  expect(await f.call("/bridge/v1/status", { worker: f.worker() }), 401, "UNAUTHORIZED");
  assert.equal(f.calls.length, 0);
});

gatewayTest("the default sixty-request session quota persists across Workers and resets at one minute", async t => {
  const f = await fixture(t);
  const session = expect(await f.provision(), 201);
  for (let index = 0; index < 60; index++) expect(await f.status(session, { worker: f.worker() }));
  const baseline = f.calls.length;
  expect(await f.status(session, { worker: f.worker() }), 429, "RATE_LIMIT");
  assert.equal(f.calls.length, baseline);
  assert.equal(f.row(session).lease_nonce, null);
  f.clock.value += 60_000;
  expect(await f.status(session, { worker: f.worker() }));
});

gatewayTest("session capacity is enforced in shared D1 and revoked/expired sessions release capacity", async t => {
  const f = await fixture(t, { maxSessions: 2, maxCreates: 20 });
  const a = expect(await f.provision(f.provisionBody({ ttlMinutes: 1 })), 201);
  expect(await f.provision(f.provisionBody({ ttlMinutes: 1 })), 201);
  const baseline = f.calls.length;
  expect(await f.provision(f.provisionBody(), { worker: f.worker() }), 429, "CAPACITY");
  assert.equal(f.calls.length, baseline);
  expect(await f.call("/bridge/v1/session", { method: "DELETE", credential: a.credential }));
  expect(await f.provision(f.provisionBody({ ttlMinutes: 1 }), { worker: f.worker() }), 201);
  f.clock.value += 60_000;
  expect(await f.provision(f.provisionBody(), { worker: f.worker() }), 201);
  assert.equal(f.db.sqlite.prepare("SELECT COUNT(*) AS count FROM link_gateway_sessions").get().count, 1, "Provisioning prunes expired session rows.");
});

gatewayTest("the thirty-two-send quota still allows cached retries but not changed content or a new request", async t => {
  const f = await fixture(t);
  const session = expect(await f.provision(), 201);
  const firstBody = { text: "Bounded outgoing history", requestId: "send-0" };
  let first;
  for (let index = 0; index < 32; index++) {
    const sent = expect(await f.send(session, { ...firstBody, requestId: `send-${index}` }), 202);
    if (index === 0) first = sent;
  }
  const baseline = f.calls.length;
  expect(await f.send(session, { ...firstBody, requestId: "send-32" }), 429, "SEND_LIMIT");
  const duplicate = expect(await f.send(session, firstBody, { worker: f.worker() }), 202);
  samePrivate(duplicate.messageId, first.messageId);
  assert.equal(duplicate.duplicate, true);
  expect(await f.send(session, { ...firstBody, text: "Changed" }), 409, "REQUEST_ID_CONFLICT");
  assert.equal(f.calls.length, baseline);
  assert.equal(expect(await f.status(session)).outgoingRequests, 32);
});

gatewayTest("the sixteen-message inbox remains durable across lost ACKs without consuming a message beyond its quota", async t => {
  const f = await fixture(t);
  const session = expect(await f.provision(), 201);
  const sent = [];
  for (let index = 0; index < 17; index++) sent.push(await f.owner.send(f.room.sessionId, { text: `Inbox quota ${index}`, requestId: `inbox-${index}` }));
  const first = expect(await f.receive(session));
  assert.equal(first.messages.length, 8);
  assert.equal(first.moreMayBeAvailable, true);
  const firstIds = first.messages.map(message => message.messageId);
  f.once("POST", "acks", loseAfter);
  expect(await f.ack(session, firstIds), 502, "RELAY_UNAVAILABLE");
  const second = expect(await f.receive(session, { worker: f.worker() }));
  assert.equal(second.messages.length, 16);
  const firstSet = new Set(firstIds);
  const secondIds = second.messages.filter(message => !firstSet.has(message.messageId)).map(message => message.messageId);
  assert.equal(secondIds.length, 8);
  f.once("POST", "acks", loseAfter);
  expect(await f.ack(session, secondIds), 502, "RELAY_UNAVAILABLE");
  const allIds = new Set(second.messages.map(message => message.messageId));
  const pending = sent.find(message => !allIds.has(message.messageId)).messageId;
  const full = expect(await f.receive(session));
  assert.equal(full.messages.length, 16);
  assert.equal(full.inboxLimit, 16);
  assert.equal(f.state(session).seen.includes(pending), false, "A full inbox must not mark a deferred message as consumed.");
  assert.equal(f.queued(session.participantId, pending), 1);
  expect(await f.ack(session, [firstIds[0]]));
  const admitted = expect(await f.receive(session));
  assert.equal(admitted.messages.length, 16);
  assert.equal(admitted.messages.some(message => message.messageId === pending), true);
  expect(await f.ack(session, admitted.messages.map(message => message.messageId)));
  assert.equal(expect(await f.receive(session)).messages.length, 0);
});

gatewayTest("per-session leases serialize independent Workers without blocking a different session", async t => {
  const f = await fixture(t);
  const a = expect(await f.provision(), 201);
  const b = expect(await f.provision(), 201);
  const entered = f.gate();
  const release = f.gate();
  f.once("GET", "status", async (_call, forward) => {
    entered.resolve();
    await release.promise;
    return forward();
  });
  const active = f.status(a);
  await reached(entered);
  const baseline = f.calls.length;
  expect(await f.status(a, { worker: f.worker() }), 409, "SESSION_BUSY");
  assert.equal(f.calls.length, baseline);
  expect(await f.status(b, { worker: f.worker() }));
  release.resolve();
  expect(await active);
  assert.equal(f.row(a).lease_nonce, null);
  expect(await f.status(a, { worker: f.worker() }));
});

gatewayTest("a superseded Worker cannot start a relay send or release the newer Worker's lease", async t => {
  const f = await fixture(t);
  const session = expect(await f.provision(), 201);
  const saved = f.gate();
  const resumeOld = f.gate();
  let pauseOnce = true;
  const delayedDb = interceptDatabase(f.db, async operation => {
    const value = operation.execute();
    if (pauseOnce && operation.method === "run" && /UPDATE link_gateway_sessions SET state_ciphertext =/.test(operation.sql)) {
      pauseOnce = false;
      saved.resolve();
      await resumeOld.promise;
    }
    return value;
  });
  const body = { text: "Persisted but not yet dispatched", requestId: "stale-before-dispatch" };
  const old = f.send(session, body, { env: { ...f.env, DB: delayedDb } });
  await reached(saved);
  const envelope = f.state(session).sends[0].envelope;
  f.clock.value += 60_001;
  const enteredNew = f.gate();
  const resumeNew = f.gate();
  f.once("GET", "status", async (_call, forward) => {
    enteredNew.resolve();
    await resumeNew.promise;
    return forward();
  });
  const newer = f.status(session, { worker: f.worker() });
  await reached(enteredNew);
  const newerLease = f.row(session).lease_nonce;
  const baseline = f.calls.length;
  resumeOld.resolve();
  expect(await old, 409, "SESSION_BUSY");
  assert.equal(f.calls.length, baseline, "Fencing must run before starting another upstream call.");
  samePrivate(f.row(session).lease_nonce, newerLease, "The stale finally block must not release a newer lease.");
  resumeNew.resolve();
  expect(await newer);
  const retried = expect(await f.send(session, body, { worker: f.worker() }), 202);
  samePrivate(retried.messageId, envelope.messageId);
  sameJsonPrivate(JSON.parse(f.calls.at(-1).body), envelope, "Recovery preserves the pre-dispatch envelope (redacted).");
});

gatewayTest("a stale already-dispatched send cannot overwrite another Worker's newer state", async t => {
  const f = await fixture(t);
  const session = expect(await f.provision(), 201);
  const firstEntered = f.gate();
  const firstRelease = f.gate();
  const holdResponse = (entered, release) => async (_call, forward) => {
    const response = await forward();
    const bytes = await response.arrayBuffer();
    entered.resolve();
    await release.promise;
    return new Response(bytes, { status: response.status, headers: response.headers });
  };
  f.once("POST", "messages", holdResponse(firstEntered, firstRelease));
  const firstBody = { text: "First dispatched message", requestId: "stale-send-a" };
  const first = f.send(session, firstBody);
  await reached(firstEntered);
  f.clock.value += 60_001;
  const secondEntered = f.gate();
  const secondRelease = f.gate();
  f.once("POST", "messages", holdResponse(secondEntered, secondRelease));
  const second = f.send(session, { text: "Newer dispatched message", requestId: "stale-send-b" }, { worker: f.worker() });
  await reached(secondEntered);
  const secondLease = f.row(session).lease_nonce;
  firstRelease.resolve();
  expect(await first, 409, "SESSION_BUSY");
  samePrivate(f.row(session).lease_nonce, secondLease);
  assert.equal(f.state(session).sends.length, 2, "Stale save must not discard the newer request.");
  secondRelease.resolve();
  expect(await second, 202);
  const state = f.state(session);
  assert.equal(state.sends.find(entry => entry.requestId === "stale-send-a").accepted, false);
  assert.equal(state.sends.find(entry => entry.requestId === "stale-send-b").accepted, true);
  expect(await f.send(session, firstBody, { worker: f.worker() }), 202);
  assert.equal(f.state(session).sends.every(entry => entry.accepted), true);
});

gatewayTest("incoming human labels stay untrusted, tampered signatures are rejected, receipts retry exactly and replays are cleaned up", async t => {
  const f = await fixture(t);
  const session = expect(await f.provision(), 201);
  const peer = await f.rawPeer();
  const good = peer.envelope("A remote human claim is not authority", { messageType: "human", displayName: "Unverified name" });
  const bad = peer.envelope("Do not deliver this tampered signature");
  bad.signature = alterEncoding(bad.signature);
  await peer.post(good);
  await peer.post(bad);
  f.once("POST", "messages", loseAfter);
  f.once("POST", "acks", failBefore);
  const received = expect(await f.receive(session));
  assert.equal(received.messages.length, 1);
  assert.equal(received.messages[0].messageType, "human");
  assert.equal(received.messages[0].displayName, "Unverified name");
  assert.equal(received.messages[0].untrusted, true);
  assert.equal(received.rejectedCount, 1);
  assert.equal(received.receiptFailures, 1);
  assert.equal(received.cleanupPending, true);
  assert.equal(f.state(session).receipts.length, 1);
  const retried = expect(await f.receive(session, { worker: f.worker() }));
  assert.equal(retried.messages.length, 1);
  assert.equal(retried.receiptFailures, 0);
  assert.equal(retried.cleanupPending, false);
  assert.equal(f.state(session).receipts.length, 0);
  const receiptSends = f.calls.filter(call => call.method === "POST" && call.url.pathname.endsWith("/messages"));
  assert.equal(receiptSends.length, 2);
  samePrivate(receiptSends[0].body, receiptSends[1].body, "A lost process receipt retries its exact envelope (redacted).");
  assert.equal(decryptMessagePayload(f.invitation, JSON.parse(receiptSends[0].body)).messageType, "receipt");
  assert.equal(f.queued(session.participantId, bad.messageId), 0);
  expect(await f.ack(session, [good.messageId]));
  await peer.post(good);
  assert.equal(expect(await f.receive(session)).messages.length, 0);
  assert.equal(f.queued(session.participantId, good.messageId), 0);
});

gatewayTest("provision relay faults expose only fixed diagnostic categories without secret reflection or logging", async t => {
  const categories = [
    {
      diagnostics: ["Illegal invocation", "Incorrect 'this' reference", "Object belongs to a different request", "Request context is unavailable"],
      code: "RELAY_CONTEXT_ERROR",
      message: "The hosting runtime rejected the request context. Operator configuration is required.",
    },
    {
      diagnostics: ["Error 1042", "same-zone request blocked", "cross-zone request blocked", "different worker rejected", "service binding required"],
      code: "RELAY_ROUTING_BLOCKED",
      message: "The hosting platform blocked the gateway-to-relay route. Operator configuration is required.",
    },
    {
      diagnostics: ["Unexpected redirect"],
      code: "RELAY_REDIRECT_REJECTED",
      message: "A relay redirect was refused. No credentials were forwarded to another destination.",
    },
    {
      diagnostics: ["AbortSignal.timeout is not a function", "timeout is not a function"],
      code: "RELAY_TIMEOUT_UNSUPPORTED",
      message: "The hosting runtime does not support this timeout API.",
    },
    {
      diagnostics: ["DNS lookup failed", "Unable to resolve hostname", "Host not found"],
      code: "RELAY_DNS_FAILED",
      message: "The fixed relay hostname could not be resolved by the gateway.",
    },
    {
      diagnostics: ["TLS handshake failed", "SSL connection failed", "Certificate verification failed"],
      code: "RELAY_TLS_FAILED",
      message: "The gateway could not verify the relay TLS connection. Certificate checks remain enabled.",
    },
    {
      diagnostics: ["Connection failed", "Socket closed", "Network unreachable", "fetch failed"],
      code: "RELAY_CONNECTION_FAILED",
      message: "The hosting runtime could not complete the relay connection.",
    },
    {
      diagnostics: ["Synthetic opaque transport failure"],
      code: "RELAY_UNAVAILABLE",
      message: "Relay outcome is unconfirmed. No automatic retry was made.",
    },
  ];
  const f = await fixture(t, { maxCreates: categories.reduce((count, category) => count + category.diagnostics.length, 0) });
  const body = f.provisionBody();
  // Deliberately does not contain a diagnostic keyword: category selection must
  // depend on the runtime fault, not on accidental bytes in synthetic secrets.
  const secretMarker = "SYNTHETIC_PRIVATE_MARKER_MUST_NOT_ESCAPE";
  let logCount = 0;
  for (const method of ["debug", "error", "info", "log", "warn", "trace", "dir", "table"]) {
    t.mock.method(console, method, () => { logCount++; });
  }
  const localRequestCount = f.relay.requests.length;
  let faultCount = 0;
  for (const { diagnostics, code, message } of categories) {
    for (const diagnostic of diagnostics) {
      f.once("POST", "join", async () => { throw new Error(`${diagnostic}: ${secretMarker}`); });
      const result = await f.provision(body, { worker: f.worker() });
      expect(result, 502);
      const reflected = JSON.stringify({ body: result.value, headers: [...result.headers] });
      assert.equal(reflected.includes(secretMarker), false, "Synthetic private marker must not be reflected (redacted).");
      sameJsonPrivate(result.value, { error: { code, message } }, "Only the fixed diagnostic code/message may be returned (redacted).");
      assert.equal(logCount, 0, "Relay exceptions must not be logged.");
      assert.equal(f.calls.length, ++faultCount, "Each provision attempt makes just one explicit relay call.");
      assert.equal(f.relay.requests.length, localRequestCount, "The injected fault must not forward a relay request.");
    }
  }
});

gatewayTest("default relay fetch preserves the global receiver and resolves the current global function per invocation", async t => {
  const db = await createGatewayTestDatabase();
  t.after(() => db.close());
  const env = { DB: db, LINK_GATEWAY_MASTER_KEY: key() };
  const invitation = createInvitation();
  const ownerId = randomId();
  const now = Date.now();
  const savedFetch = globalThis.fetch;
  const calls = [0, 0];
  let activeIndex = 0;
  function installFetch(index) {
    // A normal function exposes an unbound invocation. This stub never calls
    // native fetch, including on assertion failures or unexpected destinations.
    globalThis.fetch = function (input, init) {
      assert.equal(this === globalThis, true, "Default relay fetch must retain its global receiver.");
      assert.equal(index, activeIndex, "Default relay fetch must resolve the current global binding.");
      calls[index]++;
      const url = new URL(input);
      assert.equal(url.origin, RELAY);
      samePrivate(url.pathname, `/v1/rooms/${invitation.roomId}/join`);
      assert.equal(url.search, "");
      assert.equal(init.method, "POST");
      assert.equal(init.redirect, "manual");
      assert.equal(init.signal instanceof AbortSignal, true);
      assert.equal(new Headers(init.headers).get("accept"), "application/json");
      samePrivate(new Headers(init.headers).get("authorization"), `Bearer ${deriveRoomCapability(invitation)}`);
      const body = JSON.parse(init.body);
      assert.equal(verifyControlProof("join", invitation.roomId, body, body.publicKey), true);
      return Response.json({
        protocolVersion: 2, expiresAt: new Date(now + 60 * 60_000).toISOString(),
        participantCount: 2, maxParticipants: 8,
        participants: [{ participantId: ownerId, role: "owner" }, { participantId: body.participantId, role: "member" }],
      });
    };
  }
  try {
    installFetch(0);
    // Deliberately omit fetchRelay; the fixture's injected transport would hide
    // both an unbound global receiver and a stale captured fetch implementation.
    const worker = createGateway({ now: () => now });
    for (activeIndex = 0; activeIndex < calls.length; activeIndex++) {
      if (activeIndex === 1) installFetch(1);
      const request = new Request(`${GATEWAY}/bridge/v1/sessions`, {
        method: "POST", headers: { "cf-connecting-ip": IP, "content-type": "application/json" },
        body: JSON.stringify({ invitationCode: invitation.code, consentToPlaintextGateway: true, provisioningKey: key() }),
      });
      const response = await worker.fetch(request, env);
      const session = expect({ status: response.status, headers: response.headers, value: await response.json() }, 201);
      assert.equal(session.mode, "trusted-https-gateway");
    }
    assert.deepEqual(calls, [1, 1], "Both global implementations must be invoked by the same Worker.");
  } finally {
    globalThis.fetch = savedFetch;
  }
});

gatewayTest("synthetic 3xx responses are categorized without following redirects or exposing upstream secrets", async t => {
  const statuses = [300, 301, 302, 303, 304, 305, 306, 307, 308, 399];
  const f = await fixture(t, { maxCreates: statuses.length * 15 });
  const path = `/v1/rooms/${f.invitation.roomId}/join`;
  const secretMarker = "SYNTHETIC_PRIVATE_REDIRECT_MARKER";
  const cases = [
    { location: `${path}/?private=${secretMarker}`, code: "RELAY_SLASH_REDIRECT" },
    { location: `${RELAY}${path}/?private=${secretMarker}`, code: "RELAY_SLASH_REDIRECT" },
    { location: `${path}?private=${secretMarker}`, code: "RELAY_SAME_ORIGIN_REDIRECT" },
    { location: `${RELAY}/other?private=${secretMarker}`, code: "RELAY_SAME_ORIGIN_REDIRECT" },
    { location: `?private=${secretMarker}`, code: "RELAY_SAME_ORIGIN_REDIRECT" },
    { location: `#${secretMarker}`, code: "RELAY_SAME_ORIGIN_REDIRECT" },
    { location: `https://chatgpt.com/auth?private=${secretMarker}`, code: "RELAY_SIGNIN_REDIRECT" },
    { location: `https://auth.openai.com/auth?private=${secretMarker}`, code: "RELAY_SIGNIN_REDIRECT" },
    { location: `https://auth0.openai.com/auth?private=${secretMarker}`, code: "RELAY_SIGNIN_REDIRECT" },
    { location: `https://attacker.invalid/?private=${secretMarker}`, code: "RELAY_EXTERNAL_REDIRECT" },
    { location: `//chatgpt.com.attacker.invalid/?private=${secretMarker}`, code: "RELAY_EXTERNAL_REDIRECT" },
    { location: `https://sub.chatgpt.com/?private=${secretMarker}`, code: "RELAY_EXTERNAL_REDIRECT" },
    { location: `https://chatgpt.com@attacker.invalid/?private=${secretMarker}`, code: "RELAY_EXTERNAL_REDIRECT" },
    { location: `http://${new URL(RELAY).host}${path}/?private=${secretMarker}`, code: "RELAY_EXTERNAL_REDIRECT" },
    { location: `http://[${secretMarker}`, code: "RELAY_EXTERNAL_REDIRECT" },
  ];
  const message = "A relay redirect was blocked without following it or forwarding credentials. Operator configuration is required.";
  const body = f.provisionBody();
  const localRequestCount = f.relay.requests.length;
  let logCount = 0;
  for (const method of ["debug", "error", "info", "log", "warn", "trace", "dir", "table"]) {
    t.mock.method(console, method, () => { logCount++; });
  }
  let attempts = 0;
  for (const status of statuses) {
    for (const { location, code } of cases) {
      let cancelled = false;
      f.once("POST", "join", async () => {
        // A 304 cannot have a body in the Fetch API. Other responses retain an
        // unread secret-bearing stream so cancellation can be verified too.
        const upstreamBody = status === 304 ? null : new ReadableStream({
          start(controller) { controller.enqueue(new TextEncoder().encode(`Upstream private body: ${secretMarker}`)); },
          cancel() { cancelled = true; },
        });
        return new Response(upstreamBody, { status, headers: {
          location, "set-cookie": `synthetic=${secretMarker}`, "x-upstream-secret": secretMarker,
        } });
      });
      const result = await f.provision(body, { worker: f.worker() });
      expect(result, 502);
      sameJsonPrivate(result.value, { error: { code, message } }, "Redirect responses must contain only the fixed category/message (redacted).");
      assert.equal(JSON.stringify({ body: result.value, headers: [...result.headers] }).includes(secretMarker), false, "Redirect secrets must not be reflected (redacted).");
      for (const header of ["location", "set-cookie", "x-upstream-secret"]) assert.equal(result.headers.has(header), false);
      assert.equal(cancelled, status !== 304, "Unread redirect bodies must be cancelled.");
      assert.equal(f.calls.length, ++attempts, "No redirect follow or automatic retry may start another relay call.");
      assert.equal(f.relay.requests.length, localRequestCount, "The injected redirect must not forward a request or credentials.");
      assert.equal(logCount, 0, "Redirect URLs and bodies must not be logged.");
    }
  }
});
