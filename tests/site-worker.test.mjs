import assert from "node:assert/strict";
import test from "node:test";
import { createInvitation, decryptMessage, encryptMessage, parseInvitation, randomId } from "../plugin/src/protocol.mjs";
import { createSitesRelay } from "../site/worker/index.js";
import { createD1TestDatabase, sqliteAvailable } from "./support/d1-test-db.mjs";

const ACCESS_TOKEN = "test-only-access-token-with-32-bytes";
const ORIGIN = "https://codex-link.test";

function request(worker, path, { db, method = "GET", body, token = ACCESS_TOKEN } = {}) {
  const headers = new Headers();
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (body !== undefined) headers.set("content-type", "application/json");
  return worker.fetch(new Request(`${ORIGIN}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }), { CODEX_LINK_ACCESS_TOKEN: ACCESS_TOKEN, DB: db });
}

test("D1 relay stores ciphertext only, enforces the token, ACKs and expires messages", { skip: !sqliteAvailable }, async () => {
  const db = await createD1TestDatabase();
  const worker = createSitesRelay({ roomTtlMs: 5_000, messageTtlMs: 25, cleanupIntervalMs: 0 });
  const invitation = createInvitation();
  const alice = randomId();
  const bob = randomId();

  try {
    const unavailableRequest = new Request(`${ORIGIN}/v1/rooms`, {
      headers: { authorization: `Bearer ${ACCESS_TOKEN}` },
    });
    const unavailable = await worker.fetch(unavailableRequest, { CODEX_LINK_ACCESS_TOKEN: ACCESS_TOKEN });
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
    await new Promise((resolve) => setTimeout(resolve, 35));
    const expired = await request(worker, `/v1/rooms/${invitation.roomId}/messages?participantId=${bob}`, { db });
    assert.deepEqual((await expired.json()).messages, []);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM codex_link_messages").get().count, 0);

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
  const invitation = createInvitation();
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

test("the D1 relay enforces a per-recipient queue limit and idempotent retries", { skip: !sqliteAvailable }, async () => {
  const db = await createD1TestDatabase();
  const worker = createSitesRelay({ maxPending: 1, cleanupIntervalMs: 0 });
  const invitation = createInvitation();
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
