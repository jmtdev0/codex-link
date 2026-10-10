import assert from "node:assert/strict";
import test from "node:test";
import { createInvitation, decryptMessage, encryptMessage, parseInvitation, randomId } from "../plugin/src/protocol.mjs";
import { relayBaseUrl } from "../plugin/src/relay-client.mjs";

test("invitation code contains high-entropy room and secret values and round-trips", () => {
  const invitation = createInvitation();
  assert.match(invitation.code, /^cl1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(parseInvitation(invitation.code), invitation);
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

test("remote relay configuration requires HTTPS and a separate access token", () => {
  const previousUrl = process.env.CODEX_LINK_RELAY_URL;
  const previousToken = process.env.CODEX_LINK_ACCESS_TOKEN;
  const previousSitesToken = process.env.CODEX_LINK_SITES_BYPASS_TOKEN;
  const previousSitesOrigin = process.env.CODEX_LINK_SITES_ALLOWED_ORIGIN;
  try {
    process.env.CODEX_LINK_RELAY_URL = "http://relay.example.test";
    delete process.env.CODEX_LINK_ACCESS_TOKEN;
    delete process.env.CODEX_LINK_SITES_BYPASS_TOKEN;
    assert.throws(() => relayBaseUrl(), /HTTPS/i);

    process.env.CODEX_LINK_RELAY_URL = "https://relay.example.test";
    assert.throws(() => relayBaseUrl(), /ACCESS_TOKEN/i);

    process.env.CODEX_LINK_ACCESS_TOKEN = "test-only-access-token";
    assert.equal(relayBaseUrl(), "https://relay.example.test");

    process.env.CODEX_LINK_RELAY_URL = "https://relay.test.chatgpt.site";
    assert.throws(() => relayBaseUrl(), /SITES_BYPASS_TOKEN/i);
    process.env.CODEX_LINK_SITES_BYPASS_TOKEN = "test-only-sites-bypass-token";
    assert.throws(() => relayBaseUrl(), /SITES_ALLOWED_ORIGIN/i);
    process.env.CODEX_LINK_SITES_ALLOWED_ORIGIN = "https://relay.test.chatgpt.site";
    assert.equal(relayBaseUrl(), "https://relay.test.chatgpt.site");
    process.env.CODEX_LINK_RELAY_URL = "https://other.chatgpt.site";
    assert.throws(() => relayBaseUrl(), /match CODEX_LINK_SITES_ALLOWED_ORIGIN exactly/i);
  } finally {
    if (previousUrl === undefined) delete process.env.CODEX_LINK_RELAY_URL;
    else process.env.CODEX_LINK_RELAY_URL = previousUrl;
    if (previousToken === undefined) delete process.env.CODEX_LINK_ACCESS_TOKEN;
    else process.env.CODEX_LINK_ACCESS_TOKEN = previousToken;
    if (previousSitesToken === undefined) delete process.env.CODEX_LINK_SITES_BYPASS_TOKEN;
    else process.env.CODEX_LINK_SITES_BYPASS_TOKEN = previousSitesToken;
    if (previousSitesOrigin === undefined) delete process.env.CODEX_LINK_SITES_ALLOWED_ORIGIN;
    else process.env.CODEX_LINK_SITES_ALLOWED_ORIGIN = previousSitesOrigin;
  }
});
