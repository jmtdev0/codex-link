import assert from "node:assert/strict";
import test from "node:test";
import { createIdentity, createInvitation, decryptMessage, encryptMessage, parseInvitation, randomId } from "../plugin/src/protocol.mjs";
import { createSitesRelay } from "../site/worker/index.js";
import { createD1TestDatabase, sqliteAvailable } from "./support/d1-test-db.mjs";

const RATE_LIMIT_KEY = "test-only-site-rate-limit-secret-32-bytes";
const ROOM_CAPABILITY = "A".repeat(43);
const TEST_IP = "192.0.2.15";
const ORIGIN = "https://codex-link.test";

function request(worker, path, { db, method = "GET", body, token = ROOM_CAPABILITY } = {}) {
  const headers = new Headers();
  if (token) headers.set("authorization", `Bearer ${token}`);
  headers.set("cf-connecting-ip", TEST_IP);
  if (body !== undefined) headers.set("content-type", "application/json");
  return worker.fetch(new Request(`${ORIGIN}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }), { CODEX_LINK_RATE_LIMIT_KEY: RATE_LIMIT_KEY, DB: db });
}

test("D1 relay stores ciphertext only, enforces room capabilities, ACKs and expires messages", { skip: !sqliteAvailable }, async (t) => {
  // The short TTL must follow the test clock, not scheduling delays in parallel runs.
  let simulatedNow = Date.now();
  t.mock.method(Date, "now", () => simulatedNow);
  const messageTtlMs = 25;
  const db = await createD1TestDatabase();
  const worker = createSitesRelay({ roomTtlMs: 5_000, messageTtlMs, cleanupIntervalMs: 0 });
  const invitation = createInvitation({ version: 1 });
  const alice = randomId();
  const bob = randomId();

  try {
    const unavailableRequest = new Request(`${ORIGIN}/v1/rooms`, {
      headers: { authorization: `Bearer ${ROOM_CAPABILITY}` },
    });
    const unavailable = await worker.fetch(unavailableRequest, { CODEX_LINK_RATE_LIMIT_KEY: RATE_LIMIT_KEY });
    assert.equal(unavailable.status, 503);

    const unauthorized = await request(worker, "/v1/rooms", { db, method: "POST", body: { roomId: invitation.roomId, participantId: alice }, token: "wrong-token" });
    assert.equal(unauthorized.status, 401);

    const created = await request(worker, "/v1/rooms", { db, method: "POST", body: { roomId: invitation.roomId, participantId: alice } });
    assert.equal(created.status, 201);
    await request(worker, `/v1/rooms/${invitation.roomId}/join`, { db, method: "POST", body: { participantId: bob } });

    const plaintext = "solo el agente remoto debe leer esto";
    const envelope = encryptMessage(invitation, alice, plaintext);
    const sent = await request(worker, `/v1/rooms/${invitation.roomId}/messages`, { db, method: "POST", body: envelope });
    assert.equal(sent.status, 202);
    const persisted = db.sqlite.prepare("SELECT envelope_json FROM codex_link_messages").all();
    const storedText = JSON.stringify(persisted);
    assert.equal(storedText.includes(plaintext), false);
    assert.equal(storedText.includes(invitation.secret), false);

    const pendingResponse = await request(worker, `/v1/rooms/${invitation.roomId}/messages?participantId=${bob}`, { db });
    const pending = await pendingResponse.json();
    assert.equal(decryptMessage(invitation, pending.messages[0]), plaintext);

    const ack = await request(worker, `/v1/rooms/${invitation.roomId}/acks`, {
      db,
      method: "POST",
      body: { participantId: bob, messageIds: [envelope.messageId] },
    });
    assert.deepEqual(await ack.json(), { acknowledged: 1 });
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM codex_link_messages").get().count, 0);

    const expiringEnvelope = encryptMessage(invitation, alice, "temporal");
    await request(worker, `/v1/rooms/${invitation.roomId}/messages`, { db, method: "POST", body: expiringEnvelope });
    simulatedNow += messageTtlMs - 1;
    const beforeExpiry = await request(worker, `/v1/rooms/${invitation.roomId}/messages?participantId=${bob}`, { db });
    const beforeExpiryMessages = (await beforeExpiry.json()).messages;
    assert.equal(beforeExpiryMessages.length, 1);
    assert.equal(decryptMessage(invitation, beforeExpiryMessages[0]), "temporal");
    simulatedNow += 1;
    const expired = await request(worker, `/v1/rooms/${invitation.roomId}/messages?participantId=${bob}`, { db });
    assert.deepEqual((await expired.json()).messages, []);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM codex_link_messages").get().count, 0);
    const expiredAck = await request(worker, `/v1/rooms/${invitation.roomId}/acks`, {
      db,
      method: "POST",
      body: { participantId: bob, messageIds: [expiringEnvelope.messageId] },
    });
    assert.deepEqual(await expiredAck.json(), { acknowledged: 0 });

    const closed = await request(worker, `/v1/rooms/${invitation.roomId}`, { db, method: "DELETE", body: { participantId: alice } });
    assert.equal(closed.status, 200);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM codex_link_rooms").get().count, 0);
  } finally {
    db.close();
  }
});

test("separate Worker instances share rooms and ciphertext through the D1 binding", { skip: !sqliteAvailable }, async () => {
  const db = await createD1TestDatabase();
  const firstInstance = createSitesRelay({ cleanupIntervalMs: 0, waitPollMs: 5 });
  const secondInstance = createSitesRelay({ cleanupIntervalMs: 0, waitPollMs: 5 });
  const invitation = createInvitation({ version: 1 });
  const peerInvitation = parseInvitation(invitation.code);
  const alice = randomId();
  const bob = randomId();

  try {
    const created = await request(firstInstance, "/v1/rooms", { db, method: "POST", body: { roomId: invitation.roomId, participantId: alice } });
    assert.equal(created.status, 201);
    const joined = await request(secondInstance, `/v1/rooms/${invitation.roomId}/join`, { db, method: "POST", body: { participantId: bob } });
    assert.equal(joined.status, 200);

    const waiting = request(secondInstance, `/v1/rooms/${invitation.roomId}/messages?participantId=${bob}&waitMs=500`, { db });
    const aliceText = "mensaje cifrado de Alice a Bob entre instancias";
    const envelope = encryptMessage(invitation, alice, aliceText);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const sent = await request(firstInstance, `/v1/rooms/${invitation.roomId}/messages`, { db, method: "POST", body: envelope });
    assert.equal(sent.status, 202);
    const received = await (await waiting).json();
    assert.equal(decryptMessage(peerInvitation, received.messages[0]), aliceText);
    const stored = JSON.stringify(db.sqlite.prepare("SELECT envelope_json FROM codex_link_messages").all());
    assert.equal(stored.includes(aliceText), false);
    assert.equal(stored.includes(invitation.secret), false);

    const ackAtBob = await request(secondInstance, `/v1/rooms/${invitation.roomId}/acks`, {
      db,
      method: "POST",
      body: { participantId: bob, messageIds: [envelope.messageId] },
    });
    assert.deepEqual(await ackAtBob.json(), { acknowledged: 1 });

    const bobText = "respuesta cifrada de Bob a Alice entre instancias";
    const reply = encryptMessage(peerInvitation, bob, bobText);
    assert.equal((await request(secondInstance, `/v1/rooms/${invitation.roomId}/messages`, { db, method: "POST", body: reply })).status, 202);
    const replyResponse = await request(firstInstance, `/v1/rooms/${invitation.roomId}/messages?participantId=${alice}`, { db });
    const replyInbox = await replyResponse.json();
    assert.equal(decryptMessage(invitation, replyInbox.messages[0]), bobText);
    assert.equal(JSON.stringify(replyInbox).includes(invitation.secret), false);

    const ackAtAlice = await request(firstInstance, `/v1/rooms/${invitation.roomId}/acks`, {
      db,
      method: "POST",
      body: { participantId: alice, messageIds: [reply.messageId] },
    });
    assert.deepEqual(await ackAtAlice.json(), { acknowledged: 1 });
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM codex_link_messages").get().count, 0);
  } finally {
    db.close();
  }
});

test("v2 group rooms register self-certifying identities and fan out only ciphertext to every member", { skip: !sqliteAvailable }, async () => {
  const db = await createD1TestDatabase();
  const worker = createSitesRelay({ cleanupIntervalMs: 0 });
  const invitation = createInvitation();
  const identities = Array.from({ length: 9 }, () => createIdentity());
  const [alice, bob, carol, ...overflowCandidates] = identities;

  try {
    const created = await request(worker, "/v1/rooms", {
      db,
      method: "POST",
      body: { roomId: invitation.roomId, participantId: alice.participantId, protocolVersion: 2, publicKey: alice.publicKey },
    });
    assert.equal(created.status, 201);
    for (const identity of [bob, carol, ...overflowCandidates.slice(0, 5)]) {
      const joined = await request(worker, `/v1/rooms/${invitation.roomId}/join`, {
        db,
        method: "POST",
        body: { participantId: identity.participantId, protocolVersion: 2, publicKey: identity.publicKey },
      });
      assert.equal(joined.status, 200);
    }
    const overCapacity = await request(worker, `/v1/rooms/${invitation.roomId}/join`, {
      db,
      method: "POST",
      body: { participantId: overflowCandidates[5].participantId, protocolVersion: 2, publicKey: overflowCandidates[5].publicKey },
    });
    assert.equal(overCapacity.status, 409);

    const plaintext = "contenido solo para los extremos";
    const envelope = encryptMessage(invitation, alice.participantId, plaintext, alice);
    const sent = await request(worker, `/v1/rooms/${invitation.roomId}/messages`, { db, method: "POST", body: envelope });
    assert.equal(sent.status, 202, await sent.text());
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM codex_link_messages").get().count, 7);
    const stored = JSON.stringify(db.sqlite.prepare("SELECT envelope_json FROM codex_link_messages").all());
    assert.equal(stored.includes(plaintext), false);
    assert.equal(stored.includes(invitation.secret), false);

    for (const identity of identities.slice(1, 8)) {
      const pending = await (await request(worker, `/v1/rooms/${invitation.roomId}/messages?participantId=${identity.participantId}`, { db })).json();
      assert.equal(decryptMessage(invitation, pending.messages[0]), plaintext);
    }

    const spoofed = { ...envelope, senderId: bob.participantId };
    assert.equal((await request(worker, `/v1/rooms/${invitation.roomId}/messages`, { db, method: "POST", body: spoofed })).status, 400);
    const status = await (await request(worker, `/v1/rooms/${invitation.roomId}/status?participantId=${alice.participantId}`, { db })).json();
    assert.equal(status.participantCount, 8);
    assert.equal(status.maxParticipants, 8);

    const unauthorizedClose = await request(worker, `/v1/rooms/${invitation.roomId}`, {
      db,
      method: "DELETE",
      body: { participantId: bob.participantId },
    });
    assert.equal(unauthorizedClose.status, 403);
    const left = await request(worker, `/v1/rooms/${invitation.roomId}/leave`, {
      db,
      method: "POST",
      body: { participantId: carol.participantId },
    });
    assert.deepEqual(await left.json(), { left: true });
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM codex_link_room_members WHERE room_id = ?").get(invitation.roomId).count, 7);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM codex_link_messages WHERE recipient_id = ?").get(carol.participantId).count, 0);
  } finally {
    db.close();
  }
});

test("the D1 relay enforces a per-recipient queue limit and idempotent retries", { skip: !sqliteAvailable }, async () => {
  const db = await createD1TestDatabase();
  const worker = createSitesRelay({ maxPending: 1, cleanupIntervalMs: 0 });
  const invitation = createInvitation({ version: 1 });
  const alice = randomId();
  const bob = randomId();

  try {
    await request(worker, "/v1/rooms", { db, method: "POST", body: { roomId: invitation.roomId, participantId: alice } });
    await request(worker, `/v1/rooms/${invitation.roomId}/join`, { db, method: "POST", body: { participantId: bob } });
    const firstEnvelope = encryptMessage(invitation, alice, "primero");
    assert.equal((await request(worker, `/v1/rooms/${invitation.roomId}/messages`, { db, method: "POST", body: firstEnvelope })).status, 202);
    assert.equal((await request(worker, `/v1/rooms/${invitation.roomId}/messages`, { db, method: "POST", body: firstEnvelope })).status, 202);
    const secondEnvelope = encryptMessage(invitation, alice, "segundo");
    assert.equal((await request(worker, `/v1/rooms/${invitation.roomId}/messages`, { db, method: "POST", body: secondEnvelope })).status, 429);
  } finally {
    db.close();
  }
});

test("the D1 relay bounds request bodies before parsing them", { skip: !sqliteAvailable }, async () => {
  const db = await createD1TestDatabase();
  const worker = createSitesRelay({ cleanupIntervalMs: 0 });
  const invitation = createInvitation();

  try {
    const response = await request(worker, "/v1/rooms", {
      db,
      method: "POST",
      body: {
        roomId: invitation.roomId,
        participantId: randomId(),
        padding: "x".repeat(25 * 1024),
      },
    });
    assert.equal(response.status, 413);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM codex_link_rooms").get().count, 0);
  } finally {
    db.close();
  }
});

test("public room creation is rate-limited by a pseudonymized source address", { skip: !sqliteAvailable }, async () => {
  const db = await createD1TestDatabase();
  const worker = createSitesRelay({ maxRoomCreatesPerIp: 1, cleanupIntervalMs: 0 });
  const first = createInvitation();
  const second = createInvitation();

  try {
    const created = await request(worker, "/v1/rooms", {
      db,
      method: "POST",
      body: { roomId: first.roomId, participantId: randomId() },
    });
    assert.equal(created.status, 201);
    const limited = await request(worker, "/v1/rooms", {
      db,
      method: "POST",
      body: { roomId: second.roomId, participantId: randomId() },
    });
    assert.equal(limited.status, 429);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM codex_link_rooms").get().count, 1);
    const storedBuckets = JSON.stringify(db.sqlite.prepare("SELECT bucket_key FROM codex_link_rate_limits").all());
    assert.equal(storedBuckets.includes(TEST_IP), false);
  } finally {
    db.close();
  }
});

test("requests within one room share a persistent rate limit", { skip: !sqliteAvailable }, async () => {
  const db = await createD1TestDatabase();
  const worker = createSitesRelay({ maxRoomRequestsPerMinute: 1, cleanupIntervalMs: 0 });
  const invitation = createInvitation();
  const owner = randomId();
  const peer = randomId();

  try {
    const created = await request(worker, "/v1/rooms", {
      db,
      method: "POST",
      body: { roomId: invitation.roomId, participantId: owner },
    });
    assert.equal(created.status, 201);
    const joined = await request(worker, `/v1/rooms/${invitation.roomId}/join`, {
      db,
      method: "POST",
      body: { participantId: peer },
    });
    assert.equal(joined.status, 200);
    const limited = await request(worker, `/v1/rooms/${invitation.roomId}/status?participantId=${owner}`, { db });
    assert.equal(limited.status, 429);
  } finally {
    db.close();
  }
});
