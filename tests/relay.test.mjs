import assert from "node:assert/strict";
import test from "node:test";
import {
  acknowledgeEnvelopes,
  createRoom,
  joinRoom,
  receiveEnvelopes,
  sendEnvelope,
} from "../plugin/src/relay-client.mjs";
import { createIdentity, createInvitation, decryptMessage, deriveRoomCapability, encryptMessage, randomId } from "../plugin/src/protocol.mjs";
import { createRelayServer } from "../dev-relay/server.mjs";

test("two participants exchange only ciphertext through the volatile relay", async (t) => {
  const relay = createRelayServer({ port: 0 });
  const address = await relay.listen();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  t.after(() => relay.close());

  const invitation = createInvitation({ version: 1 });
  const capability = deriveRoomCapability(invitation);
  const alice = randomId();
  const bob = randomId();
  await createRoom(baseUrl, invitation.roomId, alice, capability);
  await joinRoom(baseUrl, invitation.roomId, bob, capability);

  const plaintext = "este texto solo aparece en los extremos";
  const envelope = encryptMessage(invitation, alice, plaintext);
  await sendEnvelope(baseUrl, envelope, capability);

  const pending = await receiveEnvelopes(baseUrl, invitation.roomId, bob, capability);
  assert.equal(pending.messages.length, 1);
  assert.equal(JSON.stringify(pending).includes(plaintext), false);
  assert.equal(decryptMessage(invitation, pending.messages[0]), plaintext);

  const repeated = await receiveEnvelopes(baseUrl, invitation.roomId, bob, capability);
  assert.equal(repeated.messages.length, 1, "unacknowledged ciphertext is retried");
  await acknowledgeEnvelopes(baseUrl, invitation.roomId, bob, [envelope.messageId], capability);
  assert.equal((await receiveEnvelopes(baseUrl, invitation.roomId, bob, capability)).messages.length, 0);

  assert.equal([...relay.rooms.values()][0].queues.get(bob).size, 0);
});

test("the relay rejects a third participant and does not log or persist messages", async (t) => {
  const relay = createRelayServer({ port: 0 });
  const address = await relay.listen();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  t.after(() => relay.close());

  const invitation = createInvitation({ version: 1 });
  const capability = deriveRoomCapability(invitation);
  const alice = randomId();
  const bob = randomId();
  const carol = randomId();
  await createRoom(baseUrl, invitation.roomId, alice, capability);
  await joinRoom(baseUrl, invitation.roomId, bob, capability);
  await assert.rejects(joinRoom(baseUrl, invitation.roomId, carol, capability), /maximum 2/i);
  assert.equal(relay.rooms.size, 1);
  assert.equal([...relay.rooms.values()][0].participants.size, 2);
});

test("messages are delivered via a bounded wait without durable storage", async (t) => {
  const relay = createRelayServer({ port: 0 });
  const address = await relay.listen();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  t.after(() => relay.close());

  const invitation = createInvitation({ version: 1 });
  const capability = deriveRoomCapability(invitation);
  const alice = randomId();
  const bob = randomId();
  await createRoom(baseUrl, invitation.roomId, alice, capability);
  await joinRoom(baseUrl, invitation.roomId, bob, capability);

  const waiting = receiveEnvelopes(baseUrl, invitation.roomId, bob, capability, 2_000);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const envelope = encryptMessage(invitation, alice, "wake");
  await sendEnvelope(baseUrl, envelope, capability);
  assert.equal((await waiting).messages[0].messageId, envelope.messageId);
});

test("unacknowledged ciphertext expires from the volatile room queue", async (t) => {
  const relay = createRelayServer({ port: 0, messageTtlMs: 25 });
  const address = await relay.listen();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  t.after(() => relay.close());

  const invitation = createInvitation({ version: 1 });
  const capability = deriveRoomCapability(invitation);
  const alice = randomId();
  const bob = randomId();
  await createRoom(baseUrl, invitation.roomId, alice, capability);
  await joinRoom(baseUrl, invitation.roomId, bob, capability);
  await sendEnvelope(baseUrl, encryptMessage(invitation, alice, "ephemeral"), capability);
  await new Promise((resolve) => setTimeout(resolve, 35));

  assert.equal((await receiveEnvelopes(baseUrl, invitation.roomId, bob, capability)).messages.length, 0);
  assert.equal([...relay.rooms.values()][0].queues.get(bob).size, 0);
});

test("development relay refuses non-loopback binding without an explicit access token", () => {
  assert.throws(() => createRelayServer({ host: "0.0.0.0", port: 0, accessToken: "" }), /requires an explicit access token/i);
});

test("v2 group rooms authenticate senders and fan out ciphertext to every other member", async (t) => {
  const relay = createRelayServer({ port: 0 });
  const address = await relay.listen();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  t.after(() => relay.close());

  const invitation = createInvitation();
  const capability = deriveRoomCapability(invitation);
  const identities = Array.from({ length: 3 }, () => createIdentity());
  const [alice, bob, carol] = identities;
  await createRoom(baseUrl, invitation.roomId, alice.participantId, capability, {
    protocolVersion: 2,
    publicKey: alice.publicKey,
  });
  for (const identity of [bob, carol]) {
    await joinRoom(baseUrl, invitation.roomId, identity.participantId, capability, {
      protocolVersion: 2,
      publicKey: identity.publicKey,
    });
  }

  const plaintext = "mensaje para todo el grupo";
  const envelope = encryptMessage(invitation, alice.participantId, plaintext, alice);
  await sendEnvelope(baseUrl, envelope, capability);
  for (const identity of [bob, carol]) {
    const pending = await receiveEnvelopes(baseUrl, invitation.roomId, identity.participantId, capability);
    assert.equal(pending.messages.length, 1);
    assert.equal(decryptMessage(invitation, pending.messages[0]), plaintext);
    assert.equal(JSON.stringify(pending).includes(plaintext), false);
  }

  const forged = { ...envelope, senderId: bob.participantId };
  await assert.rejects(async () => decryptMessage(invitation, forged), /identity/i);
});

test("v2 group rooms cap membership at eight while v1 stays pairwise", async (t) => {
  const relay = createRelayServer({ port: 0 });
  const address = await relay.listen();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  t.after(() => relay.close());

  const invitation = createInvitation();
  const capability = deriveRoomCapability(invitation);
  const identities = Array.from({ length: 9 }, () => createIdentity());
  const [owner, ...others] = identities;
  await createRoom(baseUrl, invitation.roomId, owner.participantId, capability, { protocolVersion: 2, publicKey: owner.publicKey });
  for (const identity of others.slice(0, 7)) {
    await joinRoom(baseUrl, invitation.roomId, identity.participantId, capability, { protocolVersion: 2, publicKey: identity.publicKey });
  }
  await assert.rejects(
    joinRoom(baseUrl, invitation.roomId, others[7].participantId, capability, { protocolVersion: 2, publicKey: others[7].publicKey }),
    /maximum 8/i,
  );
});
