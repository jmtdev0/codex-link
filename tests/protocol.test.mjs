import assert from "node:assert/strict";
import test from "node:test";
import { createInvitation, decryptMessage, deriveRoomCapability, encryptMessage, parseInvitation, randomId } from "../plugin/src/protocol.mjs";
import { relayBaseUrl } from "../plugin/src/relay-client.mjs";

test("invitation code contains high-entropy room and secret values and round-trips", () => {
  const invitation = createInvitation();
  assert.match(invitation.code, /^cl1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(parseInvitation(invitation.code), invitation);
});

test("room capability is stable and domain-separated from the E2E invitation secret", () => {
  const invitation = createInvitation();
  const parsed = parseInvitation(invitation.code);
  const capability = deriveRoomCapability(invitation);
  assert.match(capability, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(deriveRoomCapability(parsed), capability);
  assert.notEqual(capability, invitation.secret);
});

test("AES-GCM envelope decrypts only with the matching room secret", () => {
  const invitation = createInvitation();
  const senderId = randomId();
  const envelope = encryptMessage(invitation, senderId, "hola desde Codex");
  const seen = new Set();
  assert.equal(decryptMessage(parseInvitation(invitation.code), envelope, seen), "hola desde Codex");
  assert.equal(seen.has(envelope.messageId), true);

  const wrongInvitation = { ...invitation, secret: createInvitation().secret };
  assert.throws(() => decryptMessage(wrongInvitation, envelope), /authentication failed/i);
});

test("tampering, room substitution, and replays are rejected", () => {
  const invitation = createInvitation();
  const envelope = encryptMessage(invitation, randomId(), "mensaje protegido");
  const seen = new Set();

  const changed = { ...envelope, ciphertext: `${envelope.ciphertext.slice(0, -1)}${envelope.ciphertext.endsWith("A") ? "B" : "A"}` };
  assert.throws(() => decryptMessage(invitation, changed), /authentication failed|invalid/i);

  assert.throws(
    () => decryptMessage({ ...invitation, roomId: createInvitation().roomId }, envelope),
    /another room/i,
  );

  decryptMessage(invitation, envelope, seen);
  assert.throws(() => decryptMessage(invitation, envelope, seen), /replay rejected/i);
});

test("envelopes contain no plaintext fields and each encryption uses a fresh nonce", () => {
  const invitation = createInvitation();
  const senderId = randomId();
  const one = encryptMessage(invitation, senderId, "no plaintext here");
  const two = encryptMessage(invitation, senderId, "no plaintext here");
  assert.equal(JSON.stringify(one).includes("no plaintext here"), false);
  assert.notEqual(one.nonce, two.nonce);
  assert.notEqual(one.messageId, two.messageId);
});

test("empty and over-limit messages are rejected", () => {
  const invitation = createInvitation();
  assert.throws(() => encryptMessage(invitation, randomId(), "   "), /non-empty/i);
  assert.throws(() => encryptMessage(invitation, randomId(), "x".repeat(9_000)), /8 KiB/i);
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
