// Optional TRUSTED compatibility mode: this Worker CAN read room plaintext.
// The original E2E clients, plugin and relay do not depend on this file.
export const VERSION = "0.9.0";
export const RELAY = "https://codex-link-relay.sarda0x.chatgpt.site";
const ID = /^[A-Za-z0-9_-]{22}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,80}$/;
const RECEIPT = "[[codex-link-receipt:v1]]";
const TYPES = ["message", "human", "agent_ack", "agent_progress", "agent_reply", "receipt"];
const SEND_TYPES = ["message", "agent_ack", "agent_progress", "agent_reply"];
const utf8 = new TextEncoder();
const MAX_BODY = 16 * 1024;
const MAX_STATE = 768 * 1024;
const MAX_INBOX = 16;
const MAX_SENDS = 32;
const MAX_HISTORY = 512;
const LEASE_MS = 60_000;
const PROVISION_MS = 5 * 60_000;
const TTL_MAX = 24 * 60 * 60 * 1000;
const SECURITY_HEADERS = {
  "cache-control": "no-store", "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff", "x-frame-options": "DENY",
  "permissions-policy": "camera=(), microphone=(), geolocation=()", vary: "authorization",
};
class GatewayError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
function fail(status, code, message) { throw new GatewayError(status, code, message); }
function invalid() { fail(400, "INVALID_INPUT", "Invalid request fields. See the HTTPS gateway guide."); }
function json(status, value) {
  return new Response(JSON.stringify(value), { status, headers: { ...SECURITY_HEADERS, "content-type": "application/json; charset=utf-8" } });
}
function fields(body, allowed, required = []) {
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(k => !allowed.includes(k)) || required.some(k => !(k in body))) invalid();
}
function encode(bytes) {
  let raw = "";
  for (let i = 0; i < bytes.length; i += 4096) raw += String.fromCharCode(...bytes.subarray(i, i + 4096));
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function decode(value, length) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid encoding");
  const bytes = Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
  if (length !== undefined && bytes.length !== length || encode(bytes) !== value) throw new Error("Invalid encoding");
  return bytes;
}
function random(length = 16) { return encode(crypto.getRandomValues(new Uint8Array(length))); }
async function digest(value) { return encode(new Uint8Array(await crypto.subtle.digest("SHA-256", utf8.encode(value)))); }
async function hkdf(secret, salt, info) {
  const key = await crypto.subtle.importKey("raw", decode(secret, 32), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: utf8.encode(info) }, key, 256));
}
async function cryptKey(key) { return crypto.subtle.importKey("raw", decode(key, 32), "AES-GCM", false, ["encrypt", "decrypt"]); }
async function seal(key, value, aad) {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const bytes = utf8.encode(JSON.stringify(value));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: utf8.encode(aad) }, await cryptKey(key), bytes));
  return `${encode(nonce)}.${encode(encrypted)}`;
}
async function unseal(key, value, aad, maxBytes) {
  const parts = value.split(".");
  if (parts.length !== 2 || value.length > Math.ceil(maxBytes * 1.4) + 100) throw new Error("Invalid capsule");
  const encrypted = decode(parts[1]);
  if (encrypted.length < 17 || encrypted.length > maxBytes + 16) throw new Error("Invalid capsule");
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decode(parts[0], 12), additionalData: utf8.encode(aad) }, await cryptKey(key), encrypted);
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
}
function invitation(code) {
  try {
    const parts = code.trim().split(".");
    if (parts.length !== 3 || parts[0] !== "cl2") throw new Error();
    decode(parts[1], 16); decode(parts[2], 32);
    return { version: 2, roomId: parts[1], secret: parts[2] };
  } catch { invalid(); }
}
function label(value = "HTTPS guest") {
  if (typeof value !== "string") invalid();
  const text = value.normalize("NFC").trim();
  if (!text || [...text].length > 32 || utf8.encode(text).length > 128 || /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u.test(text)) invalid();
  return text;
}
async function identity() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const publicBytes = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", publicBytes));
  return { participantId: encode(hash.slice(0, 16)), publicKey: encode(publicBytes), privateKey: encode(new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey))) };
}
async function sign(id, bytes) {
  const key = await crypto.subtle.importKey("pkcs8", decode(id.privateKey, 48), { name: "Ed25519" }, false, ["sign"]);
  return encode(new Uint8Array(await crypto.subtle.sign("Ed25519", key, bytes)));
}
async function proof(ticket, action, body) {
  const p = { v: 1, issuedAt: Date.now(), nonce: random() };
  const data = action === "join" ? [2, ticket.identity.publicKey] : action === "acks" ? [...new Set(body.messageIds)].sort() : [];
  p.signature = await sign(ticket.identity, utf8.encode(JSON.stringify([
    "codex-link/control/v1", action, ticket.invitation.roomId, ticket.identity.participantId, data, p.v, p.issuedAt, p.nonce,
  ])));
  return p;
}
function signatureBytes(e) { return utf8.encode(JSON.stringify([e.v, e.roomId, e.senderId, e.messageId, e.nonce, e.ciphertext, e.tag, e.publicKey])); }
function aad(e) { return `codex-link/v2|${e.roomId}|${e.senderId}|${e.messageId}`; }
async function messageKey(inv, senderId) {
  // Existing protocol uses UTF-8 roomId here, not its decoded bytes.
  const key = await hkdf(inv.secret, utf8.encode(inv.roomId), `codex-link/v2/message/${senderId}`);
  return crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function encrypt(ticket, text, options = {}) {
  if (typeof text !== "string" || !text.trim()) invalid();
  const payload = { type: "text", text };
  if (options.messageType && options.messageType !== "message") payload.messageType = options.messageType;
  if (options.displayName) payload.displayName = options.displayName;
  if (options.inReplyTo) payload.inReplyTo = options.inReplyTo;
  const plaintext = utf8.encode(JSON.stringify(payload));
  if (plaintext.length > 8192) invalid();
  const e = { v: 2, roomId: ticket.invitation.roomId, senderId: ticket.identity.participantId, messageId: random(), nonce: random(12), publicKey: ticket.identity.publicKey };
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: decode(e.nonce, 12), additionalData: utf8.encode(aad(e)) }, await messageKey(ticket.invitation, e.senderId), plaintext));
  e.ciphertext = encode(encrypted.slice(0, -16)); e.tag = encode(encrypted.slice(-16));
  e.signature = await sign(ticket.identity, signatureBytes(e));
  return e;
}
async function decrypt(ticket, e) {
  if (!e || Object.keys(e).sort().join(",") !== "ciphertext,messageId,nonce,publicKey,roomId,senderId,signature,tag,v" || e.v !== 2 || e.roomId !== ticket.invitation.roomId || typeof e.senderId !== "string" || !ID.test(e.senderId) || typeof e.messageId !== "string" || !ID.test(e.messageId) || e.senderId === ticket.identity.participantId) throw new Error("Invalid envelope");
  const publicBytes = decode(e.publicKey, 44);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", publicBytes));
  if (encode(hash.slice(0, 16)) !== e.senderId) throw new Error("Invalid identity");
  const key = await crypto.subtle.importKey("spki", publicBytes, { name: "Ed25519" }, false, ["verify"]);
  if (!await crypto.subtle.verify("Ed25519", key, decode(e.signature, 64), signatureBytes(e))) throw new Error("Invalid signature");
  const ciphertext = decode(e.ciphertext);
  if (!ciphertext.length || ciphertext.length > 8192) throw new Error("Invalid size");
  const combined = new Uint8Array(ciphertext.length + 16);
  combined.set(ciphertext); combined.set(decode(e.tag, 16), ciphertext.length);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: decode(e.nonce, 12), additionalData: utf8.encode(aad(e)) }, await messageKey(ticket.invitation, e.senderId), combined);
  if (plaintext.byteLength > 8192) throw new Error("Invalid size");
  const p = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
  if (p?.type !== "text" || typeof p.text !== "string" || !p.text.trim() || !TYPES.includes(p.messageType ?? "message") || p.inReplyTo !== undefined && (typeof p.inReplyTo !== "string" || !ID.test(p.inReplyTo))) throw new Error("Invalid payload");
  if (p.displayName !== undefined) label(p.displayName);
  return { text: p.text, messageType: p.messageType ?? "message", ...(p.displayName ? { displayName: p.displayName } : {}), ...(p.inReplyTo ? { inReplyTo: p.inReplyTo } : {}) };
}
async function readJson(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("content-type") ?? "")) fail(415, "JSON_REQUIRED", "Use application/json.");
  const reader = request.body?.getReader(); if (!reader) invalid();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) { await reader.cancel().catch(() => {}); fail(413, "BODY_TOO_LARGE", "Request body is too large."); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { invalid(); }
}
function changes(result) { return Number(result?.meta?.changes ?? result?.changes ?? 0); }
async function first(db, sql, ...values) { return db.prepare(sql).bind(...values).first(); }
async function run(db, sql, ...values) { return db.prepare(sql).bind(...values).run(); }
function remember(array, value, max = MAX_HISTORY) {
  if (array.includes(value)) return;
  if (array.length >= max) fail(429, "HISTORY_LIMIT", "This disposable test session reached its history limit. Close its room and create another.");
  array.push(value);
}
function initialState() { return { inbox: [], sends: [], seen: [], incoming: [], cleanup: [], receipts: [] }; }

// Dependency injection is for offline tests only; never derived from HTTP input.
export function createGateway({ fetchRelay = (input, init) => globalThis.fetch(input, init), now = Date.now, maxSessions = 100, maxCreates = 4, maxRequests = 60, maxIngress = 240 } = {}) {
  async function rate(db, key, windowMs, limit) {
    const time = now();
    const result = await first(db, `INSERT INTO link_gateway_limits (bucket_key, window_started_at, request_count) VALUES (?, ?, 1)
      ON CONFLICT(bucket_key) DO UPDATE SET
      window_started_at = CASE WHEN link_gateway_limits.window_started_at <= ? THEN excluded.window_started_at ELSE link_gateway_limits.window_started_at END,
      request_count = CASE WHEN link_gateway_limits.window_started_at <= ? THEN 1 ELSE link_gateway_limits.request_count + 1 END
      RETURNING request_count`, key, time, time - windowMs, time - windowMs);
    if (!result || result.request_count > limit) fail(429, "RATE_LIMIT", "Too many requests. Wait before retrying.");
  }
  async function relay(ticket, method, operation, body) {
    const path = `/v1/rooms/${ticket.invitation.roomId}/${operation}`;
    const suffix = method === "GET" ? `?participantId=${ticket.identity.participantId}${operation === "messages" ? "&waitMs=0" : ""}` : "";
    const cap = encode(await hkdf(ticket.invitation.secret, decode(ticket.invitation.roomId, 16), "codex-link/v2/relay-capability"));
    // Fencing prevents a resumed stale Worker from writing state or starting a
    // new relay call. Already-dispatched upstream calls cannot be recalled.
    if (ticket.guard) await ticket.guard();
    let response;
    try {
      response = await fetchRelay(RELAY + path + suffix, { method, redirect: "manual", signal: AbortSignal.timeout(8000), headers: { accept: "application/json", authorization: `Bearer ${cap}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch (error) {
      // Fixed categories only. Never reflect or log exception messages/headers.
      const diagnostic = typeof error?.message === "string" ? error.message : "";
      if (/illegal invocation|incorrect.*this.*reference|different request|request context/i.test(diagnostic)) fail(502, "RELAY_CONTEXT_ERROR", "The hosting runtime rejected the request context. Operator configuration is required.");
      if (/1042|same.zone|cross.zone|different worker|service binding/i.test(diagnostic)) fail(502, "RELAY_ROUTING_BLOCKED", "The hosting platform blocked the gateway-to-relay route. Operator configuration is required.");
      if (/redirect/i.test(diagnostic)) fail(502, "RELAY_REDIRECT_REJECTED", "A relay redirect was refused. No credentials were forwarded to another destination.");
      if (/AbortSignal|timeout is not a function/i.test(diagnostic)) fail(502, "RELAY_TIMEOUT_UNSUPPORTED", "The hosting runtime does not support this timeout API.");
      if (/dns|resolve|host not found/i.test(diagnostic)) fail(502, "RELAY_DNS_FAILED", "The fixed relay hostname could not be resolved by the gateway.");
      if (/certificate|tls|ssl/i.test(diagnostic)) fail(502, "RELAY_TLS_FAILED", "The gateway could not verify the relay TLS connection. Certificate checks remain enabled.");
      if (/connection|socket|unreachable|fetch failed/i.test(diagnostic)) fail(502, "RELAY_CONNECTION_FAILED", "The hosting runtime could not complete the relay connection.");
      fail(502, "RELAY_UNAVAILABLE", "Relay outcome is unconfirmed. No automatic retry was made.");
    }
    if (response.status >= 300 && response.status < 400) {
      let category = "RELAY_EXTERNAL_REDIRECT";
      try {
        const target = new URL(response.headers.get("location"), RELAY + path + suffix);
        if (target.origin === RELAY) category = target.pathname === path + "/" ? "RELAY_SLASH_REDIRECT" : "RELAY_SAME_ORIGIN_REDIRECT";
        else if (["chatgpt.com", "auth.openai.com", "auth0.openai.com"].includes(target.hostname)) category = "RELAY_SIGNIN_REDIRECT";
      } catch {}
      try { await response.body?.cancel(); } catch {}
      // No Location, cookies or arbitrary upstream text are exposed or followed.
      fail(502, category, "A relay redirect was blocked without following it or forwarding credentials. Operator configuration is required.");
    }
    if (!response.ok) {
      try { await response.body?.cancel(); } catch {}
      const status = [400, 403, 404, 409, 429].includes(response.status) ? response.status : 502;
      fail(status, "RELAY_REJECTED", "The relay did not accept this operation. Check room membership, expiry, capacity and retry limits.");
    }
    const reader = response.body?.getReader(); if (!reader) fail(502, "INVALID_RELAY_RESPONSE", "Invalid relay response.");
    const chunks = []; let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > 2 * 1024 * 1024) { await reader.cancel().catch(() => {}); throw new Error(); }
        chunks.push(value);
      }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch { fail(502, "INVALID_RELAY_RESPONSE", "Invalid relay response."); }
    finally { reader.releaseLock(); }
  }
  async function control(ticket, action, values = {}) {
    const body = { participantId: ticket.identity.participantId, ...values };
    body.controlProof = await proof(ticket, action, body);
    return relay(ticket, "POST", action, body);
  }
  async function assertLease(db, ticket, lease) {
    const row = await first(db, `SELECT session_id FROM link_gateway_sessions WHERE session_id = ? AND lease_nonce = ? AND lease_until > ? AND revoked_at IS NULL AND expires_at > ?`, ticket.sessionId, lease, now(), now());
    if (!row) fail(409, "SESSION_BUSY", "The session lease expired or was superseded. Retry explicitly with the same requestId if sending.");
  }
  async function save(db, ticket, lease, state) {
    if (utf8.encode(JSON.stringify(state)).length > MAX_STATE) fail(429, "STATE_LIMIT", "Conversation state limit reached. Use a fresh session.");
    const ciphertext = await seal(ticket.stateKey, state, `link-gateway/state/v1|${ticket.sessionId}`);
    const result = await run(db, `UPDATE link_gateway_sessions SET state_ciphertext = ?, lease_until = ? WHERE session_id = ? AND lease_nonce = ? AND lease_until > ? AND revoked_at IS NULL AND expires_at > ?`, ciphertext, now() + LEASE_MS, ticket.sessionId, lease, now(), now());
    if (changes(result) !== 1) fail(409, "SESSION_BUSY", "The session lease expired. Retry explicitly with the same requestId if sending.");
  }
  async function provision(request, env, url) {
    if (request.headers.has("authorization")) invalid();
    const ip = request.headers.get("cf-connecting-ip");
    if (!ip || ip.length > 128) fail(503, "RATE_PROTECTION_UNAVAILABLE", "Gateway rate protection is unavailable.");
    const ipKey = encode(await hkdf(env.LINK_GATEWAY_MASTER_KEY, utf8.encode(ip), "link-gateway/v1/create-rate"));
    await rate(env.DB, `create:${ipKey}`, 600_000, maxCreates);
    const body = await readJson(request);
    fields(body, ["invitationCode", "displayName", "ttlMinutes", "consentToPlaintextGateway", "provisioningKey"], ["invitationCode", "consentToPlaintextGateway", "provisioningKey"]);
    if (body.consentToPlaintextGateway !== true) fail(400, "CONSENT_REQUIRED", "Authorize room-wide plaintext access by the trusted gateway explicitly.");
    try { decode(body.provisioningKey, 32); } catch { invalid(); }
    const inv = invitation(body.invitationCode);
    const displayName = label(body.displayName);
    const ttl = body.ttlMinutes ?? 60;
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > 1440) invalid();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM link_gateway_sessions WHERE expires_at <= ?").bind(now()),
      env.DB.prepare("UPDATE link_gateway_sessions SET provision_ciphertext = NULL WHERE provision_until <= ? AND provision_ciphertext IS NOT NULL").bind(now()),
      env.DB.prepare("DELETE FROM link_gateway_limits WHERE window_started_at <= ?").bind(now() - TTL_MAX),
    ]);
    const provisionHash = await digest(body.provisioningKey);
    const fingerprint = await digest(JSON.stringify([url.origin, inv, displayName, ttl]));
    let row = await first(env.DB, "SELECT * FROM link_gateway_sessions WHERE provision_hash = ?", provisionHash);
    if (row && (row.provision_fingerprint !== fingerprint || row.provision_until <= now() || row.revoked_at !== null)) fail(409, "PROVISION_CONFLICT", "Provisioning key expired or was used with different fields. Do not reuse it for another room.");
    if (!row) {
      const ticket = { v: 1, audience: url.origin, sessionId: random(), invitation: inv, identity: await identity(), stateKey: random(32), displayName, expiresAt: 0 };
      const encrypted = await seal(body.provisioningKey, { ticket }, `link-gateway/provision/v1|${provisionHash}`);
      await run(env.DB, `INSERT OR IGNORE INTO link_gateway_sessions (session_id, token_hash, expires_at, provision_hash, provision_fingerprint, provision_ciphertext, provision_until)
        SELECT ?, ?, ?, ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM link_gateway_sessions WHERE expires_at > ? AND revoked_at IS NULL) < ?`, ticket.sessionId, `pending:${ticket.sessionId}`, now() + PROVISION_MS, provisionHash, fingerprint, encrypted, now() + PROVISION_MS, now(), maxSessions);
      row = await first(env.DB, "SELECT * FROM link_gateway_sessions WHERE provision_hash = ?", provisionHash);
      if (!row) fail(429, "CAPACITY", "Gateway session capacity reached.");
      if (row.provision_fingerprint !== fingerprint) fail(409, "PROVISION_CONFLICT", "This provisioning key is already in use.");
    }
    const lease = random();
    const acquired = await run(env.DB, `UPDATE link_gateway_sessions SET lease_nonce = ?, lease_until = ? WHERE session_id = ? AND revoked_at IS NULL AND expires_at > ? AND lease_until <= ?`, lease, now() + LEASE_MS, row.session_id, now(), now());
    if (changes(acquired) !== 1) fail(409, "SESSION_BUSY", "Provisioning is active. Retry with the identical provisioning key and fields.");
    try {
      // A request may have read a pending row before another Worker completed
      // setup. Refresh UNDER the lease; never finalize from that stale snapshot.
      row = await first(env.DB, `SELECT * FROM link_gateway_sessions WHERE session_id = ? AND lease_nonce = ? AND lease_until > ? AND revoked_at IS NULL AND expires_at > ?`, row.session_id, lease, now(), now());
      if (!row || row.provision_until <= now() || row.provision_fingerprint !== fingerprint) fail(409, "PROVISION_CONFLICT", "Provisioning recovery expired or was superseded.");
      // The client-held recovery key makes retries recover the SAME identity and
      // credential. D1 alone cannot decrypt this short-lived recovery record.
      const recovered = await unseal(body.provisioningKey, row.provision_ciphertext, `link-gateway/provision/v1|${provisionHash}`, 8192);
      if (recovered.result) {
        if (row.token_hash !== await digest(recovered.result.credential)) fail(409, "PROVISION_CONFLICT", "Provisioning recovery is inconsistent.");
        await assertLease(env.DB, { sessionId: row.session_id }, lease);
        return json(201, recovered.result);
      }
      const ticket = recovered.ticket;
      ticket.guard = () => assertLease(env.DB, ticket, lease);
      const joinedRoom = await control(ticket, "join", { protocolVersion: 2, publicKey: ticket.identity.publicKey });
      const roomExpiry = Date.parse(joinedRoom?.expiresAt);
      if (joinedRoom?.protocolVersion !== 2 || !Number.isSafeInteger(roomExpiry) || roomExpiry <= now() || roomExpiry > now() + TTL_MAX + 60_000) fail(502, "INVALID_RELAY_RESPONSE", "Invalid room metadata.");
      ticket.expiresAt = Math.min(now() + ttl * 60_000, roomExpiry);
      const credential = `lgw1.${await seal(env.LINK_GATEWAY_MASTER_KEY, ticket, "link-gateway/capsule/v1")}`;
      const stateCiphertext = await seal(ticket.stateKey, initialState(), `link-gateway/state/v1|${ticket.sessionId}`);
      const result = { credential, sessionId: ticket.sessionId, participantId: ticket.identity.participantId, expiresAt: new Date(ticket.expiresAt).toISOString(), mode: "trusted-https-gateway", gatewayCanReadPlaintext: true, vaultOnly: true, apiBase: `${url.origin}/bridge/v1` };
      const recovery = await seal(body.provisioningKey, { result }, `link-gateway/provision/v1|${provisionHash}`);
      const stored = await run(env.DB, `UPDATE link_gateway_sessions SET token_hash = ?, expires_at = ?, state_ciphertext = ?, provision_ciphertext = ? WHERE session_id = ? AND lease_nonce = ? AND lease_until > ? AND revoked_at IS NULL AND expires_at > ? AND token_hash = ? AND state_ciphertext IS NULL`, await digest(credential), ticket.expiresAt, stateCiphertext, recovery, ticket.sessionId, lease, now(), now(), `pending:${ticket.sessionId}`);
      if (changes(stored) !== 1) fail(409, "SESSION_BUSY", "Provisioning lease expired. Retry with the same provisioning key.");
      return json(201, result);
    } finally {
      await run(env.DB, "UPDATE link_gateway_sessions SET lease_nonce = NULL, lease_until = 0 WHERE provision_hash = ? AND lease_nonce = ?", provisionHash, lease);
    }
  }
  async function authenticate(request, env, url, { revoking = false } = {}) {
    const header = request.headers.get("authorization") ?? "";
    const match = /^Bearer (lgw1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(header);
    if (!match || header.length > 4096) fail(401, "UNAUTHORIZED", "A valid conversation credential is required in Authorization: Bearer.");
    let ticket;
    try {
      ticket = await unseal(env.LINK_GATEWAY_MASTER_KEY, match[1].slice(5), "link-gateway/capsule/v1", 2048);
      if (ticket?.v !== 1 || ticket.audience !== url.origin || !ID.test(ticket.sessionId) || !Number.isSafeInteger(ticket.expiresAt)) throw new Error();
    } catch { fail(401, "UNAUTHORIZED", "Invalid conversation credential."); }
    if (!revoking && ticket.expiresAt <= now()) fail(410, "SESSION_EXPIRED", "The conversation credential has expired. Provision a fresh session privately.");
    const row = await first(env.DB, "SELECT * FROM link_gateway_sessions WHERE session_id = ? AND token_hash = ?", ticket.sessionId, await digest(match[1]));
    if (!row || row.expires_at !== ticket.expiresAt || !revoking && (row.revoked_at !== null || row.expires_at <= now())) fail(410, "SESSION_REVOKED", "This conversation credential is no longer active.");
    if (!revoking) await rate(env.DB, `session:${ticket.sessionId}`, 60_000, maxRequests);
    return ticket;
  }
  async function revoke(request, env, url) {
    // Revocation must not depend on the shared rate quota, decryption of inbox
    // state, or an attacker releasing its lease. Authentication still applies.
    const ticket = await authenticate(request, env, url, { revoking: true });
    const result = await run(env.DB, `UPDATE link_gateway_sessions SET revoked_at = COALESCE(revoked_at, ?), state_ciphertext = NULL, provision_ciphertext = NULL, lease_nonce = NULL, lease_until = 0 WHERE session_id = ?`, now(), ticket.sessionId);
    if (changes(result) !== 1) fail(410, "SESSION_REVOKED", "This conversation credential is no longer active.");
    let roomLeft = false;
    try { roomLeft = (await control(ticket, "leave"))?.left === true; } catch {}
    return json(200, { revoked: true, roomLeft, roomClosed: false });
  }
  async function withSession(request, env, url) {
    const ticket = await authenticate(request, env, url);
    const lease = random();
    const acquired = await run(env.DB, `UPDATE link_gateway_sessions SET lease_nonce = ?, lease_until = ? WHERE session_id = ? AND revoked_at IS NULL AND expires_at > ? AND lease_until <= ?`, lease, now() + LEASE_MS, ticket.sessionId, now(), now());
    if (changes(acquired) !== 1) fail(409, "SESSION_BUSY", "Another request is active. Wait for it to finish before retrying.");
    ticket.guard = () => assertLease(env.DB, ticket, lease);
    try {
      const row = await first(env.DB, "SELECT state_ciphertext FROM link_gateway_sessions WHERE session_id = ? AND lease_nonce = ?", ticket.sessionId, lease);
      const state = await unseal(ticket.stateKey, row.state_ciphertext, `link-gateway/state/v1|${ticket.sessionId}`, MAX_STATE);
      const path = url.pathname;
      if (request.method === "GET" && path === "/bridge/v1/status") {
        const status = await relay(ticket, "GET", "status");
        if (status?.protocolVersion !== 2 || !Number.isInteger(status.participantCount) || status.participantCount < 1 || status.participantCount > 8) fail(502, "INVALID_RELAY_RESPONSE", "Invalid room metadata.");
        return json(200, { version: VERSION, mode: "trusted-https-gateway", gatewayCanReadPlaintext: true, sessionId: ticket.sessionId, participantId: ticket.identity.participantId, participantCount: status.participantCount, expiresAt: new Date(ticket.expiresAt).toISOString(), pendingMessages: state.inbox.length, outgoingRequests: state.sends.length });
      }
      const body = await readJson(request);
      if (path === "/bridge/v1/messages" && request.method === "POST") return await send(env.DB, ticket, lease, state, body);
      if (path === "/bridge/v1/receive" && request.method === "POST") return await receive(env.DB, ticket, lease, state, body);
      if (path === "/bridge/v1/acks" && request.method === "POST") return await acknowledge(env.DB, ticket, lease, state, body);
      fail(404, "NOT_FOUND", "Not found.");
    } finally {
      await run(env.DB, "UPDATE link_gateway_sessions SET lease_nonce = NULL, lease_until = 0 WHERE session_id = ? AND lease_nonce = ?", ticket.sessionId, lease);
    }
  }
  async function send(db, ticket, lease, state, body) {
    fields(body, ["text", "requestId", "messageType", "inReplyTo"], ["text", "requestId"]);
    const type = body.messageType ?? "message";
    if (typeof body.requestId !== "string" || !REQUEST_ID.test(body.requestId) || !SEND_TYPES.includes(type) || typeof body.text !== "string" || body.text.startsWith(RECEIPT) || body.inReplyTo !== undefined && (typeof body.inReplyTo !== "string" || !ID.test(body.inReplyTo) || !state.incoming.includes(body.inReplyTo)) || type !== "message" && body.inReplyTo === undefined) invalid();
    const candidate = await encrypt(ticket, body.text, { messageType: type, displayName: ticket.displayName, inReplyTo: body.inReplyTo });
    const fingerprint = await digest(JSON.stringify([body.text, type, body.inReplyTo ?? null]));
    let entry = state.sends.find(item => item.requestId === body.requestId);
    if (entry && entry.fingerprint !== fingerprint) fail(409, "REQUEST_ID_CONFLICT", "This requestId was used with different content.");
    if (!entry) {
      if (state.sends.length >= MAX_SENDS) fail(429, "SEND_LIMIT", "This test session reached its 32-send limit. Close its room and create another.");
      entry = { requestId: body.requestId, fingerprint, envelope: candidate, accepted: false, acknowledgedBy: [] };
      state.sends.push(entry);
      // Persist exact envelope BEFORE a potentially ambiguous network operation.
      await save(db, ticket, lease, state);
    }
    const duplicate = entry.accepted;
    if (!entry.accepted) {
      try {
        if ((await relay(ticket, "POST", "messages", entry.envelope))?.accepted !== true) throw new Error();
      } catch (error) {
        if (error instanceof GatewayError && error.status < 500) throw error;
        fail(502, "SEND_UNCONFIRMED", "Acceptance is unconfirmed. Retry explicitly with the SAME requestId and identical content; do not invent another ID.");
      }
      entry.accepted = true;
      await save(db, ticket, lease, state);
    }
    return json(202, { accepted: true, requestId: entry.requestId, messageId: entry.envelope.messageId, duplicate, acknowledgedBy: entry.acknowledgedBy });
  }
  async function receive(db, ticket, lease, state, body) {
    fields(body, []);
    const response = await relay(ticket, "GET", "messages");
    if (!Array.isArray(response?.messages) || response.messages.length > 100) fail(502, "INVALID_RELAY_RESPONSE", "Invalid relay message batch.");
    let rejectedCount = 0;
    const deliveryReceipts = [];
    for (const e of response.messages.slice(0, 8)) {
      if (state.inbox.some(m => m.messageId === e?.messageId)) continue;
      if (state.seen.includes(e?.messageId)) { remember(state.cleanup, e.messageId, 100); continue; }
      let p;
      try { p = await decrypt(ticket, e); }
      catch { rejectedCount++; if (typeof e?.messageId === "string" && ID.test(e.messageId)) remember(state.cleanup, e.messageId, 100); continue; }
      const receipt = p.text.match(/^\[\[codex-link-receipt:v1\]\]([A-Za-z0-9_-]{22})$/);
      if (receipt || p.messageType === "receipt") {
        remember(state.seen, e.messageId); remember(state.cleanup, e.messageId, 100);
        if (receipt) {
          const outgoing = state.sends.find(s => s.envelope.messageId === receipt[1]);
          if (outgoing && !outgoing.acknowledgedBy.includes(e.senderId)) {
            remember(outgoing.acknowledgedBy, e.senderId, 8);
            deliveryReceipts.push({ messageId: receipt[1], participantId: e.senderId });
          }
        }
        continue;
      }
      if (state.inbox.length >= MAX_INBOX) continue;
      state.inbox.push({ messageId: e.messageId, participantId: e.senderId, ...p, untrusted: true });
      remember(state.seen, e.messageId); remember(state.incoming, e.messageId);
      state.receipts.push({ messageId: e.messageId, envelope: await encrypt(ticket, RECEIPT + e.messageId, { messageType: "receipt" }) });
    }
    // Durable inbox before process receipt; a receipt is not a model-read ACK.
    await save(db, ticket, lease, state);
    const receipts = state.receipts.slice(0, 8);
    const results = await Promise.all(receipts.map(async receipt => {
      try { return (await relay(ticket, "POST", "messages", receipt.envelope))?.accepted === true; } catch { return false; }
    }));
    const sent = new Set(receipts.filter((_, index) => results[index]).map(r => r.messageId));
    state.receipts = state.receipts.filter(r => !sent.has(r.messageId));
    let cleanupPending = false;
    if (state.cleanup.length) {
      try { await control(ticket, "acks", { messageIds: state.cleanup }); state.cleanup = []; } catch { cleanupPending = true; }
    }
    await save(db, ticket, lease, state);
    return json(200, { messages: state.inbox, deliveryReceipts, rejectedCount, receiptFailures: results.filter(v => !v).length, cleanupPending, untrusted: true, moreMayBeAvailable: response.messages.length > 8, inboxLimit: MAX_INBOX });
  }
  async function acknowledge(db, ticket, lease, state, body) {
    fields(body, ["messageIds"], ["messageIds"]);
    if (!Array.isArray(body.messageIds) || body.messageIds.length < 1 || body.messageIds.length > MAX_INBOX || body.messageIds.some(id => typeof id !== "string" || !ID.test(id) || !state.incoming.includes(id))) invalid();
    const ids = [...new Set(body.messageIds)];
    const result = await control(ticket, "acks", { messageIds: ids });
    if (!Number.isInteger(result?.acknowledged) || result.acknowledged < 0 || result.acknowledged > ids.length) fail(502, "INVALID_RELAY_RESPONSE", "Queue acknowledgement was not confirmed.");
    state.inbox = state.inbox.filter(m => !ids.includes(m.messageId));
    await save(db, ticket, lease, state);
    return json(200, { acknowledged: ids.length });
  }
  return { async fetch(request, env = {}) {
    try {
      const url = new URL(request.url);
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) fail(400, "HTTPS_REQUIRED", "Use HTTPS without URL credentials or query parameters.");
      const origin = request.headers.get("origin");
      if (origin && origin !== url.origin) fail(403, "ORIGIN_REJECTED", "Cross-origin browser requests are not allowed.");
      if (request.method === "GET" && url.pathname === "/") return landing();
      if (request.method === "GET" && url.pathname === "/gateway-client.js") return clientScript();
      if (!env.DB || typeof env.DB.prepare !== "function" || typeof env.DB.batch !== "function") fail(503, "NOT_CONFIGURED", "Gateway storage is not configured.");
      try { decode(env.LINK_GATEWAY_MASTER_KEY, 32); } catch { fail(503, "NOT_CONFIGURED", "Gateway protections are not configured."); }
      if (request.method === "GET" && url.pathname === "/health") return json(200, { service: "codex-link-trusted-https-gateway", version: VERSION, gatewayCanReadPlaintext: true });
      if (request.method === "POST" && url.pathname === "/bridge/v1/sessions") return await provision(request, env, url);
      const routes = new Map([["/bridge/v1/status", "GET"], ["/bridge/v1/messages", "POST"], ["/bridge/v1/receive", "POST"], ["/bridge/v1/acks", "POST"], ["/bridge/v1/session", "DELETE"]]);
      if (routes.get(url.pathname) !== request.method) fail(404, "NOT_FOUND", "Not found.");
      if (request.method === "DELETE" && url.pathname === "/bridge/v1/session") return await revoke(request, env, url);
      const ip = request.headers.get("cf-connecting-ip");
      if (!ip || ip.length > 128) fail(503, "RATE_PROTECTION_UNAVAILABLE", "Gateway rate protection is unavailable.");
      const ingressKey = encode(await hkdf(env.LINK_GATEWAY_MASTER_KEY, utf8.encode(ip), "link-gateway/v1/ingress-rate"));
      await rate(env.DB, `ingress:${ingressKey}`, 60_000, maxIngress);
      return await withSession(request, env, url);
    } catch (error) {
      if (error instanceof GatewayError) return json(error.status, { error: { code: error.code, message: error.message } });
      // No exception reflection or application logging of tokens, room codes or bodies.
      return json(503, { error: { code: "GATEWAY_UNAVAILABLE", message: "Gateway operation could not be confirmed. Retry only explicitly; preserve requestId when sending." } });
    }
  } };
}

function landing() {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Codex Link · HTTPS gateway</title><style>
  :root{color-scheme:dark;font-family:system-ui,sans-serif;background:#10151c;color:#e4edf7}body{max-width:780px;margin:6vh auto;padding:24px}h1{font-size:2.2rem;margin:0}.badge{color:#8ed9c4}section{background:#192330;border:1px solid #304153;border-radius:14px;padding:24px;margin:24px 0}.warning{border-left:4px solid #e6b667;padding:12px 18px;background:#2a261e}label{display:block;margin:16px 0 6px}input,textarea,button{font:inherit;box-sizing:border-box}input[type=password],input[type=text],input[type=number],textarea{width:100%;padding:12px;border:1px solid #536477;border-radius:6px;background:#101923;color:inherit}button{background:#8ed9c4;color:#10221d;border:0;border-radius:6px;padding:12px 18px;margin:12px 8px 0 0;cursor:pointer}button:disabled{opacity:.45;cursor:wait}a{color:#8ed9c4}#result{white-space:pre-wrap;overflow-wrap:anywhere}#credential{height:120px}footer{font-size:.9rem;color:#a7b8cc}code{overflow-wrap:anywhere}
  </style><script src="/gateway-client.js" defer></script></head><body><p class="badge">LINK / OPTIONAL COMPATIBILITY MODE</p><h1>One room. One HTTPS credential.</h1><p>For assistants that can make HTTPS requests but cannot keep a local process running.</p><p class="warning"><strong>This gateway can read all messages in its room.</strong> Use a dedicated disposable room and non-sensitive test messages only. This is not end-to-end encryption between your assistant and Codex. The original encrypted Link mode is unchanged. This prototype has not been independently audited.</p>
  <section><h2>Provision privately</h2><p>The invitation goes to this gateway over HTTPS. Put the returned credential directly in the assistant's secure vault. Never paste invitations or credentials into chat, URLs, screenshots or command arguments. Close the dedicated room after testing; expiry does not automatically remove relay membership.</p><form id="provision"><label for="invite">Signed Link invitation</label><input id="invite" type="password" autocomplete="off" required><label for="name">Participant label (not verified identity)</label><input id="name" type="text" value="Instinct (HTTPS)" maxlength="32" required><label for="ttl">Credential lifetime (minutes, at most room expiry)</label><input id="ttl" type="number" min="1" max="1440" value="60" required><label><input id="consent" type="checkbox" required> I authorize room-wide plaintext access for non-sensitive tests.</label><button id="create" type="submit">Join room &amp; create vault credential</button></form><button id="retry" type="button" hidden>Retry the SAME provisioning attempt</button><p id="result" role="status" aria-live="polite"></p><div id="secret" hidden><label for="credential">Credential — secure vault only</label><input id="credential" type="password" readonly autocomplete="off" spellcheck="false"><button id="copy" type="button">Copy for vault</button><button id="forget" type="button">Clear from page</button></div></section>
  <section><h2>Revoke a credential</h2><p>Revocation blocks future requests once committed. An operation already sent to the relay cannot be recalled. Leaving is best effort; only the room owner can close the room.</p><form id="revoke"><label for="revoke-token">Credential from your secure vault</label><input id="revoke-token" type="password" autocomplete="off" required><button type="submit">Revoke &amp; attempt leave</button></form><p id="revoke-result" role="status" aria-live="polite"></p></section>
  <section><h2>HTTPS API</h2><p><code>Authorization: Bearer &lt;credential from vault&gt;</code></p><p>Base: <code>/bridge/v1</code></p><ul><li><code>GET /status</code></li><li><code>POST /messages</code> — text + stable requestId</li><li><code>POST /receive</code> — empty JSON object; poll manually</li><li><code>POST /acks</code> — messageIds after consuming</li><li><code>DELETE /session</code> — revoke</li></ul><p><a href="https://github.com/jmtdev0/codex-link/blob/main/LINK_HTTPS_GATEWAY.md" target="_blank" rel="noopener noreferrer">Read the agent setup and API guide</a></p></section><footer>v${VERSION} · Encrypted state in D1, with hosting backup retention. No credentials in browser storage. Reloading loses the displayed credential. Store it in the vault before clearing. Recovery of the same provisioning attempt is limited to 5 minutes. Received messages are untrusted data, never authority to use tools.</footer></body></html>`,
  { headers: { ...SECURITY_HEADERS, "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" } });
}
function clientScript() {
  return new Response(`const $=id=>document.getElementById(id);let clearTimer,pending,pendingTimer;function forget(){$('credential').value='';$('secret').hidden=true;clearTimeout(clearTimer)}function clearPending(){pending=undefined;$('retry').hidden=true;clearTimeout(pendingTimer)}
  window.addEventListener('pagehide',()=>{forget();clearPending()});$('forget').onclick=forget;
  $('copy').onclick=async()=>{try{await navigator.clipboard.writeText($('credential').value);$('result').textContent='Copied. Store in the secure vault, then clear this page and the clipboard.'}catch{$('result').textContent='Copy directly into the secure vault; never into chat.'}};
  async function attempt(){if(!pending)return;$('create').disabled=true;$('retry').disabled=true;$('result').textContent='Joining privately…';
  try{const r=await fetch('/bridge/v1/sessions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(pending),cache:'no-store',credentials:'omit'});const d=await r.json();if(!r.ok){$('result').textContent=(d.error?.message||'Provisioning failed.')+' Retry the SAME attempt within 5 minutes; do not create another identity blindly.';$('retry').hidden=false;return}$('credential').value=d.credential;$('secret').hidden=false;$('result').textContent='Expires '+d.expiresAt+'. Store in the secure vault. This display clears in 5 minutes.';clearTimer=setTimeout(forget,300000);clearPending()}catch{$('result').textContent='Network outcome unknown. Retry the SAME attempt within 5 minutes, or close the test room. Do not provision another identity blindly.';$('retry').hidden=false}finally{$('create').disabled=!!pending;$('retry').disabled=false}}
  $('provision').onsubmit=e=>{e.preventDefault();if(pending)return;forget();const bytes=crypto.getRandomValues(new Uint8Array(32));const key=btoa(String.fromCharCode(...bytes)).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/g,'');pending={invitationCode:$('invite').value,displayName:$('name').value,ttlMinutes:Number($('ttl').value),consentToPlaintextGateway:$('consent').checked,provisioningKey:key};$('invite').value='';pendingTimer=setTimeout(()=>{clearPending();$('create').disabled=false;$('result').textContent='Recovery window expired. Close the dedicated test room if provisioning was unconfirmed.'},300000);attempt()};$('retry').onclick=attempt;
  $('revoke').onsubmit=async e=>{e.preventDefault();const token=$('revoke-token').value;$('revoke-token').value='';try{const r=await fetch('/bridge/v1/session',{method:'DELETE',headers:{authorization:'Bearer '+token},cache:'no-store',credentials:'omit'});const d=await r.json();$('revoke-result').textContent=r.ok?'Revoked. Relay leave '+(d.roomLeft?'confirmed.':'unconfirmed; the room owner can close it.'):d.error?.message||'Revocation unconfirmed.'}catch{$('revoke-result').textContent='Network outcome unknown. Retry revocation explicitly.'}};`,
  { headers: { ...SECURITY_HEADERS, "content-type": "text/javascript; charset=utf-8" } });
}
const gateway = createGateway();
export default { fetch(request, env) { return gateway.fetch(request, env); } };
