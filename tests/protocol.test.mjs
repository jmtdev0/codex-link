import assert from "node:assert/strict";
import test from "node:test";
import {
  createIdentity,
  createInvitation,
  decryptMessage,
  decryptMessagePayload,
  deriveRoomCapability,
  encryptMessage,
  normalizeDisplayName,
  parseInvitation,
  randomId,
} from "../plugin/src/protocol.mjs";
import { relayBaseUrl } from "../plugin/src/relay-client.mjs";

test("v1 and v2 invitation codes round-trip with distinct protocol labels", () => {
  for (const version of [1, 2]) {
    const invitation = createInvitation({ version });
    assert.match(invitation.code, new RegExp(`^cl${version}\\.[A-Za-z0-9_-]{22}\\.[A-Za-z0-9_-]{43}$`));
    assert.deepEqual(parseInvitation(invitation.code), invitation);
  }
});

test("room capability is stable and protocol-domain-separated from the E2E secret", () => {
  const legacy = createInvitation({ version: 1 });
  const current = createInvitation({ version: 2 });
  assert.match(deriveRoomCapability(legacy), /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(deriveRoomCapability(legacy), legacy.secret);
  assert.notEqual(deriveRoomCapability(legacy), deriveRoomCapability(current));
  assert.equal(deriveRoomCapability(parseInvitation(current.code)), deriveRoomCapability(current));
});

test("legacy v1 AES-GCM messages remain decryptable", () => {
  const invitation = createInvitation({ version: 1 });
  const senderId = randomId();
  const envelope = encryptMessage(invitation, senderId, "hola desde una versión anterior", null, { displayName: "Cliente v1" });
  assert.equal(decryptMessage(parseInvitation(invitation.code), envelope), "hola desde una versión anterior");
  assert.equal(decryptMessagePayload(parseInvitation(invitation.code), envelope).displayName, "Cliente v1");
});

test("v2 authenticates sender identity and encrypts message contents", () => {
  const invitation = createInvitation();
  const identity = createIdentity();
  const envelope = encryptMessage(invitation, identity.participantId, "hola desde Codex", identity);
  assert.equal(decryptMessage(parseInvitation(invitation.code), envelope, new Set()), "hola desde Codex");
  assert.equal(JSON.stringify(envelope).includes("hola desde Codex"), false);
});

test("typed agent messages and reply references are authenticated inside ciphertext", () => {
  const invitation = createInvitation();
  const identity = createIdentity();
  const replyTarget = randomId();
  const envelope = encryptMessage(invitation, identity.participantId, "respuesta final", identity, {
    messageType: "agent_reply",
    inReplyTo: replyTarget,
  });
  const serializedEnvelope = JSON.stringify(envelope);
  assert.equal(serializedEnvelope.includes("respuesta final"), false);
  assert.equal(serializedEnvelope.includes("agent_reply"), false);
  assert.equal(serializedEnvelope.includes(replyTarget), false);
  assert.deepEqual(decryptMessagePayload(invitation, envelope), {
    text: "respuesta final",
    messageType: "agent_reply",
    inReplyTo: replyTarget,
  });
  assert.equal(decryptMessage(invitation, envelope), "respuesta final");
});

test("participant display names are normalized, bounded, and kept inside authenticated ciphertext", () => {
  const invitation = createInvitation();
  const identity = createIdentity();
  const envelope = encryptMessage(invitation, identity.participantId, "hola", identity, {
    messageType: "human",
    displayName: "  Agent Ñandú 🧭  ",
  });
  const serializedEnvelope = JSON.stringify(envelope);
  assert.equal(serializedEnvelope.includes("Agent Ñandú"), false);
  assert.equal(serializedEnvelope.includes("displayName"), false);
  assert.deepEqual(decryptMessagePayload(invitation, envelope), {
    text: "hola",
    messageType: "human",
    displayName: "Agent Ñandú 🧭",
  });
  assert.equal(normalizeDisplayName("   "), "");
  assert.throws(() => normalizeDisplayName("x".repeat(33)), /32 characters/i);
  assert.throws(() => normalizeDisplayName("name\nforged"), /control/i);
  assert.throws(() => normalizeDisplayName("\u202eadmin"), /bidirectional/i);
  assert.throws(() => normalizeDisplayName("name\u200f"), /bidirectional/i);
  assert.throws(() => normalizeDisplayName("name\u2028other"), /control/i);
});

test("v2 rejects ciphertext, identity substitution, bad signatures, and replays", () => {
  const invitation = createInvitation();
  const alice = createIdentity();
  const bob = createIdentity();
  const envelope = encryptMessage(invitation, alice.participantId, "mensaje protegido", alice);
  const seen = new Set();

  const changed = { ...envelope, ciphertext: `${envelope.ciphertext.slice(0, -1)}${envelope.ciphertext.endsWith("A") ? "B" : "A"}` };
  assert.throws(() => decryptMessage(invitation, changed), /signature|authentication|invalid/i);
  assert.throws(() => decryptMessage(invitation, { ...envelope, senderId: bob.participantId }), /identity/i);
  assert.throws(() => decryptMessage({ ...invitation, roomId: createInvitation().roomId }, envelope), /another room/i);

  assert.equal(decryptMessage(invitation, envelope, seen), "mensaje protegido");
  assert.throws(() => decryptMessage(invitation, envelope, seen), /replay rejected/i);
});

test("each encryption uses a fresh nonce and message ID", () => {
  const invitation = createInvitation();
  const identity = createIdentity();
  const one = encryptMessage(invitation, identity.participantId, "mismo texto", identity);
  const two = encryptMessage(invitation, identity.participantId, "mismo texto", identity);
  assert.notEqual(one.nonce, two.nonce);
  assert.notEqual(one.messageId, two.messageId);
});

test("empty and over-limit messages are rejected", () => {
  const invitation = createInvitation();
  const identity = createIdentity();
  assert.throws(() => encryptMessage(invitation, identity.participantId, "   ", identity), /non-empty/i);
  assert.throws(() => encryptMessage(invitation, identity.participantId, "x".repeat(9_000), identity), /8 KiB/i);
});

test("remote relay configuration requires HTTPS but no user-level relay tokens", () => {
  const previousUrl = process.env.CODEX_LINK_RELAY_URL;
  try {
    process.env.CODEX_LINK_RELAY_URL = "http://relay.example.test";
    assert.throws(() => relayBaseUrl(), /HTTPS/i);

    process.env.CODEX_LINK_RELAY_URL = "https://relay.example.test";
    assert.equal(relayBaseUrl(), "https://relay.example.test");

    process.env.CODEX_LINK_RELAY_URL = "https://relay.test.chatgpt.site";
    assert.equal(relayBaseUrl(), "https://relay.test.chatgpt.site");
    delete process.env.CODEX_LINK_RELAY_URL;
    assert.equal(relayBaseUrl(), "https://codex-link-relay.sarda0x.chatgpt.site");
  } finally {
    if (previousUrl === undefined) delete process.env.CODEX_LINK_RELAY_URL;
    else process.env.CODEX_LINK_RELAY_URL = previousUrl;
  }
});
