// Provider-neutral durable HTTPS mode. This service CAN read its room contents.
// It neither joins nor changes the independent signed E2E relay rooms.
export function createDurableLink({ now = Date.now, maxRooms = 100, maxCreates = 12, maxIngress = 240, maxRequests = 180, maxWaitMs = 25000, pollMs = 1000 } = {}) {
  const enc = new TextEncoder(), dec = new TextDecoder();
  const ID = /^[A-Za-z0-9_-]{22}$/, TOKEN = /^lks2\.[A-Za-z0-9_-]{43}$/;
  const RID = /^[A-Za-z0-9_-]{1,80}$/, COOKIE = "__Host-link-session-v2";
  const TTL = 86400000, MAX_MESSAGES = 512, MAX_BYTES = 1048576, BATCH = 50;
  const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "x-frame-options": "DENY", vary: "authorization, cookie" };
  class LinkFault extends Error { constructor(status, code, message) { super(message); Object.assign(this, { status, code }); } }
  function fail(status, code, message) { throw new LinkFault(status, code, message); }
  function invalid() { fail(400, "INVALID_INPUT", "Invalid fields. See /link-guide for the durable Link API."); }
  const b64 = bytes => { let s = ""; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""); };
  const random = (n = 16) => b64(crypto.getRandomValues(new Uint8Array(n)));
  function unb64(s, size) {
    if (typeof s !== "string" || !/^[A-Za-z0-9_-]+$/.test(s)) invalid();
    const bytes = Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0));
    if (size !== undefined && bytes.length !== size || b64(bytes) !== s) invalid();
    return bytes;
  }
  const hash = async value => b64(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(value))));
  const first = (db, sql, ...args) => db.prepare(sql).bind(...args).first();
  const run = (db, sql, ...args) => db.prepare(sql).bind(...args).run();
  const changed = result => result?.meta?.changes ?? 0;
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers });
  function fields(body, allowed, required = []) {
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(k => !allowed.includes(k)) || required.some(k => !(k in body))) invalid();
  }
  async function body(request) {
    if (!/^application\/json(?:;|$)/i.test(request.headers.get("content-type") ?? "")) fail(415, "JSON_REQUIRED", "Use application/json.");
    const reader = request.body?.getReader(); if (!reader) invalid();
    const chunks = []; let size = 0;
    try { while (true) { const next = await reader.read(); if (next.done) break; size += next.value.length;
      if (size > 16384) { await reader.cancel(); fail(413, "BODY_LIMIT", "Request exceeds 16 KiB."); } chunks.push(next.value); } }
    finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    try { return JSON.parse(dec.decode(bytes)); } catch { invalid(); }
  }
  function name(value = "Agent") {
    if (typeof value !== "string") invalid(); const result = value.normalize("NFC").trim();
    if (!result || [...result].length > 32 || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(result)) invalid(); return result;
  }
  async function derive(env, salt, purpose) {
    const master = await crypto.subtle.importKey("raw", unb64(env.LINK_GATEWAY_MASTER_KEY, 32), "HKDF", false, ["deriveBits"]);
    return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: enc.encode(salt), info: enc.encode("link-durable/v2/" + purpose) }, master, 256));
  }
  async function box(env, room, value, aad) {
    const key = await crypto.subtle.importKey("raw", await derive(env, room.audience + "|" + room.room_id, "storage"), "AES-GCM", false, ["encrypt"]);
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    return b64(nonce) + "." + b64(new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: enc.encode(aad) }, key, enc.encode(JSON.stringify(value)))));
  }
  async function open(env, room, value, aad) {
    const [nonce, ciphertext] = value.split(".");
    const key = await crypto.subtle.importKey("raw", await derive(env, room.audience + "|" + room.room_id, "storage"), "AES-GCM", false, ["decrypt"]);
    return JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(nonce, 12), additionalData: enc.encode(aad) }, key, unb64(ciphertext))));
  }
  const nameAAD = p => "link2/name|" + p.room_id + "|" + p.participant_id;
  const messageAAD = m => "link2/message|" + m.room_id + "|" + m.sender_id + "|" + m.message_id;
  async function invitation(env, room) {
    return "link2." + room.room_id + "." + b64(await derive(env, room.audience + "|" + room.room_id, "invitation"));
  }
  async function rate(db, key, limit, window = 60000) {
    const row = await first(db, "INSERT INTO link_gateway_limits (bucket_key, window_started_at, request_count) VALUES (?, ?, 1) " +
      "ON CONFLICT(bucket_key) DO UPDATE SET window_started_at = CASE WHEN window_started_at <= ? THEN excluded.window_started_at ELSE window_started_at END, " +
      "request_count = CASE WHEN window_started_at <= ? THEN 1 ELSE request_count + 1 END RETURNING request_count", key, now(), now() - window, now() - window);
    if (!row || row.request_count > limit) fail(429, "RATE_LIMIT", "Too many requests. Wait before retrying.");
  }
  async function cleanup(env) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM link_rooms_v2 WHERE expires_at <= ?").bind(now()),
      env.DB.prepare("DELETE FROM link_waiters_v2 WHERE expires_at <= ?").bind(now()),
      env.DB.prepare("DELETE FROM link_gateway_limits WHERE window_started_at <= ?").bind(now() - TTL),
    ]);
  }
  function token(request, url, allowCookie = true) {
    const authorization = request.headers.get("authorization");
    if (authorization) { const match = /^Bearer (lks2\.[A-Za-z0-9_-]{43})$/.exec(authorization); if (!match) fail(401, "SESSION_REQUIRED", "Use this participant's private Link credential."); return match[1]; }
    const cookies = request.headers.get("cookie") ?? "";
    if (allowCookie && cookies.length < 16384) {
      const value = cookies.split(";").map(s => s.trim()).find(s => s.startsWith(COOKIE + "="))?.slice(COOKIE.length + 1);
      if (value && TOKEN.test(value)) {
        if (request.method !== "GET" && request.headers.get("origin") !== url.origin) fail(403, "ORIGIN_REJECTED", "Use this Site for browser session requests.");
        return value;
      }
    }
    fail(401, "SESSION_REQUIRED", "Use this participant's private Link credential, or join once.");
  }
  function cookie(response, credential, expiresAt, clear = false) {
    response.headers.append("set-cookie", COOKIE + "=" + (clear ? "" : credential) + "; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=" + (clear ? 0 : Math.max(0, Math.ceil((expiresAt - now()) / 1000)))); return response;
  }
  async function authenticate(request, env, url, options = {}) {
    const credential = token(request, url);
    const p = await first(env.DB, "SELECT * FROM link_participants_v2 WHERE credential_hash = ?", await hash(credential));
    const room = p && await first(env.DB, "SELECT * FROM link_rooms_v2 WHERE room_id = ?", p.room_id);
    if (!p || !room || room.audience !== url.origin) fail(401, "SESSION_REQUIRED", "This Link session is unavailable.");
    if (room.expires_at <= now() || p.expires_at <= now() || p.revoked_at !== null && !options.allowRevoked || room.closed_at !== null && !options.allowClosed) fail(410, "SESSION_ENDED", "This session was revoked, closed or expired.");
    return { p, room, credential };
  }
  async function latest(env, roomId) { return (await first(env.DB, "SELECT COALESCE(MAX(sequence), 0) AS value FROM link_messages_v2 WHERE room_id = ?", roomId)).value; }
  async function describe(env, auth) {
    const members = await first(env.DB, "SELECT COUNT(*) AS count FROM link_participants_v2 WHERE room_id = ? AND revoked_at IS NULL", auth.room.room_id);
    return { roomId: auth.room.room_id, participantId: auth.p.participant_id, name: await open(env, auth.room, auth.p.name_ciphertext, nameAAD(auth.p)), role: auth.p.role,
      expiresAt: new Date(auth.room.expires_at).toISOString(), serverTime: new Date(now()).toISOString(), cursor: auth.p.confirmed_cursor,
      apiBase: auth.room.audience + "/link/v1", gatewayCanReadPlaintext: true, mode: "durable-https", participantCount: members.count, maxMessages: MAX_MESSAGES, maxRoomBytes: MAX_BYTES, maxWaitMs };
  }
  async function setup(request, env, url, creating) {
    const credential = token(request, url, false), input = await body(request);
    fields(input, creating ? ["name", "ttlMinutes", "consentToPlaintextGateway"] : ["invitation", "name", "consentToPlaintextGateway"], creating ? ["consentToPlaintextGateway"] : ["invitation", "consentToPlaintextGateway"]);
    if (input.consentToPlaintextGateway !== true) fail(400, "CONSENT_REQUIRED", "Each participant must authorize this readable HTTPS gateway once when joining.");
    const display = name(input.name), ttl = input.ttlMinutes ?? 1440;
    if (!Number.isInteger(ttl) || ttl < 1 || ttl > 1440) invalid();
    const match = !creating && /^link2\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/.exec(input.invitation);
    if (!creating && !match) invalid();
    if (match) { unb64(match[1], 16); unb64(match[2], 32); }
    const credentialHash = await hash(credential), fingerprint = await hash(JSON.stringify([url.origin, creating, display, creating ? ttl : input.invitation]));
    let p = await first(env.DB, "SELECT * FROM link_participants_v2 WHERE credential_hash = ?", credentialHash);
    if (p && p.setup_fingerprint !== fingerprint) fail(409, "SETUP_CONFLICT", "This credential belongs to a different setup. Resume it instead of joining again.");
    if (!p) {
      const room = creating ? { room_id: random(), audience: url.origin, created_at: now(), expires_at: now() + ttl * 60000, closed_at: null } : await first(env.DB, "SELECT * FROM link_rooms_v2 WHERE room_id = ?", match[1]);
      if (!room || room.audience !== url.origin || room.closed_at !== null || room.expires_at <= now() || !creating && room.invite_hash !== await hash(input.invitation)) fail(403, "INVITATION_UNAVAILABLE", "This invitation is invalid, closed or expired.");
      const participantId = random(), encryptedName = await box(env, room, display, "link2/name|" + room.room_id + "|" + participantId);
      const statements = [];
      if (creating) statements.push(env.DB.prepare("INSERT OR IGNORE INTO link_rooms_v2 (room_id, audience, invite_hash, created_at, expires_at) SELECT ?, ?, ?, ?, ? " +
        "WHERE NOT EXISTS (SELECT 1 FROM link_participants_v2 WHERE credential_hash = ?) AND (SELECT COUNT(*) FROM link_rooms_v2 WHERE expires_at > ? AND closed_at IS NULL) < ?")
        .bind(room.room_id, url.origin, await hash(await invitation(env, room)), room.created_at, room.expires_at, credentialHash, now(), maxRooms));
      statements.push(env.DB.prepare("INSERT OR IGNORE INTO link_participants_v2 (participant_id, room_id, credential_hash, setup_fingerprint, name_ciphertext, role, consented_at, expires_at) " +
        "SELECT ?, room_id, ?, ?, ?, ?, ?, expires_at FROM link_rooms_v2 WHERE room_id = ? AND audience = ? AND closed_at IS NULL AND expires_at > ? " +
        "AND (SELECT COUNT(*) FROM link_participants_v2 WHERE room_id = ? AND revoked_at IS NULL) < 8 AND (SELECT COUNT(*) FROM link_participants_v2 WHERE room_id = ?) < 32")
        .bind(participantId, credentialHash, fingerprint, encryptedName, creating ? "owner" : "member", now(), room.room_id, url.origin, now(), room.room_id, room.room_id));
      // An invitation grants this room's retained conversation, including messages
      // sent before the peer joined. Individual credentials do not cross rooms.
      statements.push(env.DB.prepare("INSERT OR IGNORE INTO link_deliveries_v2 (message_id, participant_id) SELECT m.message_id, p.participant_id FROM link_messages_v2 m " +
        "JOIN link_participants_v2 p ON p.room_id = m.room_id WHERE p.credential_hash = ? AND p.participant_id != m.sender_id AND p.revoked_at IS NULL").bind(credentialHash));
      await env.DB.batch(statements);
      p = await first(env.DB, "SELECT * FROM link_participants_v2 WHERE credential_hash = ?", credentialHash);
      if (!p) fail(429, "CAPACITY", "This bounded service or room is full. No session was created.");
      if (p.setup_fingerprint !== fingerprint) fail(409, "SETUP_CONFLICT", "This credential already belongs to another setup.");
    }
    const auth = await authenticate(new Request(url, { headers: { authorization: "Bearer " + credential } }), env, url);
    return cookie(json(201, { ...await describe(env, auth), credential, ...(creating ? { invitation: await invitation(env, auth.room) } : {}) }), credential, auth.room.expires_at);
  }
  async function send(request, env, auth, input) {
    fields(input, ["text", "requestId", "inReplyTo"], ["text", "requestId"]);
    if (typeof input.text !== "string" || !input.text.trim() || enc.encode(input.text).length > 8192 || !RID.test(input.requestId ?? "") || typeof input.requestId !== "string" || input.inReplyTo !== undefined && !ID.test(input.inReplyTo)) invalid();
    if (input.inReplyTo && !await first(env.DB, "SELECT 1 AS present FROM link_messages_v2 WHERE room_id = ? AND message_id = ?", auth.room.room_id, input.inReplyTo)) invalid();
    const fingerprint = await hash(JSON.stringify([input.text, input.inReplyTo ?? null]));
    let entry = await first(env.DB, "SELECT * FROM link_messages_v2 WHERE sender_id = ? AND request_id = ?", auth.p.participant_id, input.requestId);
    if (entry && entry.fingerprint !== fingerprint) fail(409, "REQUEST_ID_CONFLICT", "This requestId already has different content.");
    const duplicate = !!entry;
    if (!entry) {
      const messageId = random(), size = enc.encode(input.text).length;
      const payload = { text: input.text, name: await open(env, auth.room, auth.p.name_ciphertext, nameAAD(auth.p)), ...(input.inReplyTo ? { inReplyTo: input.inReplyTo } : {}) };
      const ciphertext = await box(env, auth.room, payload, "link2/message|" + auth.room.room_id + "|" + auth.p.participant_id + "|" + messageId);
      await env.DB.batch([
        env.DB.prepare("INSERT OR IGNORE INTO link_messages_v2 (sequence, room_id, sender_id, message_id, request_id, fingerprint, payload_ciphertext, size_bytes, created_at) " +
          "SELECT (SELECT COALESCE(MAX(sequence), 0) + 1 FROM link_messages_v2 WHERE room_id = ?), ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM link_rooms_v2 r JOIN link_participants_v2 p ON p.room_id = r.room_id " +
          "WHERE r.room_id = ? AND p.participant_id = ? AND r.closed_at IS NULL AND r.expires_at > ? AND p.revoked_at IS NULL) " +
          "AND (SELECT COUNT(*) FROM link_messages_v2 WHERE room_id = ?) < ? AND (SELECT COALESCE(SUM(size_bytes), 0) FROM link_messages_v2 WHERE room_id = ?) + ? <= ?")
          .bind(auth.room.room_id, auth.room.room_id, auth.p.participant_id, messageId, input.requestId, fingerprint, ciphertext, size, now(), auth.room.room_id, auth.p.participant_id, now(), auth.room.room_id, MAX_MESSAGES, auth.room.room_id, size, MAX_BYTES),
        env.DB.prepare("INSERT OR IGNORE INTO link_deliveries_v2 (message_id, participant_id) SELECT m.message_id, p.participant_id FROM link_messages_v2 m " +
          "JOIN link_participants_v2 p ON p.room_id = m.room_id WHERE m.sender_id = ? AND m.request_id = ? AND p.participant_id != m.sender_id AND p.revoked_at IS NULL")
          .bind(auth.p.participant_id, input.requestId),
      ]);
      entry = await first(env.DB, "SELECT * FROM link_messages_v2 WHERE sender_id = ? AND request_id = ?", auth.p.participant_id, input.requestId);
      if (!entry) { await authenticate(request, env, new URL(request.url)); fail(429, "ROOM_LIMIT", "Room storage is full; accepted messages remain available until expiry."); }
      if (entry.fingerprint !== fingerprint) fail(409, "REQUEST_ID_CONFLICT", "Concurrent sends reused a requestId with different content.");
    }
    return json(202, { accepted: true, messageId: entry.message_id, sequence: entry.sequence, requestId: entry.request_id, duplicate,
      expiresAt: new Date(auth.room.expires_at).toISOString(), state: "accepted" });
  }
  async function page(env, auth, after, conversation = false) {
    // Bound the page before querying it. A send arriving while decryption is in
    // progress must never advance the cursor past an unseen message.
    const upper = await latest(env, auth.room.room_id);
    const rows = (await env.DB.prepare("SELECT * FROM link_messages_v2 WHERE room_id = ? AND sequence > ? AND sequence <= ? " + (conversation ? "" : "AND sender_id != ? ") + "ORDER BY sequence LIMIT 51")
      .bind(...(conversation ? [auth.room.room_id, after, upper] : [auth.room.room_id, after, upper, auth.p.participant_id])).all()).results ?? [];
    const items = rows.slice(0, BATCH);
    const messages = await Promise.all(items.map(async m => ({ ...await open(env, auth.room, m.payload_ciphertext, messageAAD(m)), messageId: m.message_id, sequence: m.sequence,
      participantId: m.sender_id, timestamp: new Date(m.created_at).toISOString(), untrusted: true })));
    const nextCursor = rows.length > BATCH ? items.at(-1).sequence : Math.max(after, upper);
    await run(env.DB, "UPDATE link_participants_v2 SET offered_cursor = MAX(offered_cursor, ?) WHERE participant_id = ?", nextCursor, auth.p.participant_id);
    return { messages, nextCursor, more: rows.length > BATCH, expiresAt: new Date(auth.room.expires_at).toISOString(), serverTime: new Date(now()).toISOString(), untrusted: true };
  }
  function delay(ms, signal) { return new Promise(resolve => { if (signal?.aborted) return resolve();
    const end = () => { clearTimeout(timer); signal?.removeEventListener("abort", end); resolve(); }, timer = setTimeout(end, ms); signal?.addEventListener("abort", end, { once: true }); }); }
  async function receive(request, env, url, auth, input, conversation = false) {
    fields(input, conversation ? ["cursor"] : ["cursor", "waitMs"]);
    const cursor = input.cursor ?? (conversation ? 0 : auth.p.confirmed_cursor), wait = input.waitMs ?? 0;
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > await latest(env, auth.room.room_id) || !Number.isInteger(wait) || wait < 0 || wait > maxWaitMs) invalid();
    let result = await page(env, auth, cursor, conversation);
    if (result.messages.length || !wait || conversation) { await authenticate(request, env, url); return json(200, result); }
    const waiter = random(), deadline = Date.now() + wait;
    const added = await run(env.DB, "INSERT INTO link_waiters_v2 (waiter_id, participant_id, expires_at) SELECT ?, ?, ? WHERE (SELECT COUNT(*) FROM link_waiters_v2 WHERE participant_id = ? AND expires_at > ?) < 2",
      waiter, auth.p.participant_id, now() + maxWaitMs + 5000, auth.p.participant_id, now());
    if (!changed(added)) fail(429, "WAIT_LIMIT", "At most two waits may be active for one participant.");
    try {
      while (!request.signal.aborted && Date.now() < deadline) {
        await delay(Math.min(pollMs, deadline - Date.now()), request.signal);
        auth = await authenticate(request, env, url);
        result = await page(env, auth, cursor);
        if (result.messages.length) break;
      }
      await authenticate(request, env, url);
      return json(200, { ...result, aborted: request.signal.aborted });
    } finally { await run(env.DB, "DELETE FROM link_waiters_v2 WHERE waiter_id = ?", waiter); }
  }
  async function confirm(env, auth, input) {
    fields(input, ["cursor", "read"], ["cursor"]);
    if (!Number.isSafeInteger(input.cursor) || input.cursor < 0 || input.cursor > auth.p.offered_cursor || input.read !== undefined && typeof input.read !== "boolean") invalid();
    await env.DB.batch([
      env.DB.prepare("UPDATE link_deliveries_v2 SET confirmed_at = COALESCE(confirmed_at, ?), read_at = CASE WHEN ? THEN COALESCE(read_at, ?) ELSE read_at END " +
        "WHERE participant_id = ? AND message_id IN (SELECT message_id FROM link_messages_v2 WHERE room_id = ? AND sequence <= ?)")
        .bind(now(), input.read === true ? 1 : 0, now(), auth.p.participant_id, auth.room.room_id, input.cursor),
      env.DB.prepare("UPDATE link_participants_v2 SET confirmed_cursor = MAX(confirmed_cursor, ?), read_cursor = MAX(read_cursor, ?) WHERE participant_id = ?")
        .bind(input.cursor, input.read === true ? input.cursor : 0, auth.p.participant_id),
    ]);
    return json(200, { confirmed: true, cursor: input.cursor, readConfirmed: input.read === true, destructive: false });
  }
  async function outbox(env, auth, requestId) {
    if (!RID.test(requestId)) invalid();
    const m = await first(env.DB, "SELECT * FROM link_messages_v2 WHERE sender_id = ? AND request_id = ?", auth.p.participant_id, requestId);
    if (!m) return json(404, { error: { code: "REQUEST_NOT_FOUND", message: "No accepted send with this requestId exists in this session." } });
    const rows = (await env.DB.prepare("SELECT d.confirmed_at, d.read_at, p.participant_id, p.revoked_at FROM link_deliveries_v2 d JOIN link_participants_v2 p ON p.participant_id = d.participant_id WHERE d.message_id = ? ORDER BY p.participant_id").bind(m.message_id).all()).results ?? [];
    return json(200, { accepted: true, requestId, messageId: m.message_id, sequence: m.sequence, expiresAt: new Date(auth.room.expires_at).toISOString(),
      recipients: rows.map(p => ({ participantId: p.participant_id, state: p.read_at !== null ? "read-confirmed" : p.confirmed_at !== null ? "received-by-client" : p.revoked_at !== null ? "revoked" : "queued",
        receivedAt: p.confirmed_at === null ? null : new Date(p.confirmed_at).toISOString(), readAt: p.read_at === null ? null : new Date(p.read_at).toISOString() })),
      note: "A client receipt is not proof that a model or human read the message. Read confirmation is the participant's explicit report." });
  }
  return { async fetch(request, env = {}) {
    try {
      const url = new URL(request.url);
      if (url.protocol !== "https:" || url.search || url.hash || url.username || url.password) fail(400, "HTTPS_REQUIRED", "Use HTTPS without URL credentials or query parameters.");
      if (request.headers.get("origin") && request.headers.get("origin") !== url.origin || request.headers.get("sec-fetch-site") === "cross-site") fail(403, "ORIGIN_REJECTED", "Cross-origin browser access is not allowed.");
      if (request.method === "GET" && url.pathname === "/link/v1/info") return json(200, { api: "Link durable HTTPS", version: "0.12.0", gatewayCanReadPlaintext: true, maxWaitMs, ttlHours: 24, maxMessages: MAX_MESSAGES, maxRoomBytes: MAX_BYTES, historyOnJoin: true, resumable: true });
      if (!env.DB?.prepare || !env.DB?.batch || typeof env.LINK_GATEWAY_MASTER_KEY !== "string") fail(503, "NOT_CONFIGURED", "Durable Link storage is unavailable.");
      unb64(env.LINK_GATEWAY_MASTER_KEY, 32);
      const ip = request.headers.get("cf-connecting-ip"); if (!ip || ip.length > 128) fail(503, "RATE_PROTECTION_UNAVAILABLE", "Source rate protection is unavailable.");
      const source = b64(await derive(env, ip, "source-rate"));
      await rate(env.DB, "link2:ingress:" + source, maxIngress); await cleanup(env);
      if (request.method === "POST" && url.pathname === "/link/v1/identity") { fields(await body(request), []); await rate(env.DB, "link2:identity:" + source, maxCreates, 600000); return json(201, { credential: "lks2." + random(32), storePrivately: true }); }
      if (request.method === "POST" && ["/link/v1/rooms", "/link/v1/join"].includes(url.pathname)) {
        await rate(env.DB, "link2:setup:" + source, maxCreates, 600000); return await setup(request, env, url, url.pathname.endsWith("/rooms"));
      }
      const removing = request.method === "DELETE" && url.pathname === "/link/v1/session", closing = request.method === "DELETE" && url.pathname === "/link/v1/room";
      const auth = await authenticate(request, env, url, { allowRevoked: removing, allowClosed: closing });
      await rate(env.DB, "link2:participant:" + auth.p.participant_id, maxRequests);
      if (request.method === "GET" && url.pathname === "/link/v1/session") return json(200, await describe(env, auth));
      if (request.method === "POST" && url.pathname === "/link/v1/access") { fields(await body(request), []); return json(200, { credential: auth.credential, expiresAt: new Date(auth.room.expires_at).toISOString(), scope: "this participant only; never share with peers" }); }
      if (request.method === "GET" && url.pathname === "/link/v1/invitation") {
        if (auth.p.role !== "owner") fail(403, "OWNER_REQUIRED", "Only the owner can recover the room invitation.");
        return json(200, { invitation: await invitation(env, auth.room), expiresAt: new Date(auth.room.expires_at).toISOString(), grantsRetainedHistory: true });
      }
      if (request.method === "POST" && url.pathname === "/link/v1/send") return await send(request, env, auth, await body(request));
      if (request.method === "POST" && ["/link/v1/receive", "/link/v1/conversation"].includes(url.pathname)) return await receive(request, env, url, auth, await body(request), url.pathname.endsWith("/conversation"));
      if (request.method === "POST" && url.pathname === "/link/v1/confirm") return await confirm(env, auth, await body(request));
      if (request.method === "GET" && url.pathname.startsWith("/link/v1/outbox/")) return await outbox(env, auth, url.pathname.slice("/link/v1/outbox/".length));
      if (closing) {
        if (auth.p.role !== "owner") fail(403, "OWNER_REQUIRED", "Only the room owner can close it for everyone.");
        await env.DB.batch([env.DB.prepare("UPDATE link_rooms_v2 SET closed_at = COALESCE(closed_at, ?) WHERE room_id = ?").bind(now(), auth.room.room_id),
          env.DB.prepare("DELETE FROM link_messages_v2 WHERE room_id = ?").bind(auth.room.room_id)]);
        return cookie(json(200, { closed: true }), "", 0, true);
      }
      if (removing) {
        if (auth.p.role === "owner") fail(403, "OWNER_CLOSE_REQUIRED", "Owners close their room explicitly; pausing a client does not leave it.");
        await run(env.DB, "UPDATE link_participants_v2 SET revoked_at = COALESCE(revoked_at, ?) WHERE participant_id = ?", now(), auth.p.participant_id);
        return cookie(json(200, { revoked: true }), "", 0, true);
      }
      if (request.method === "POST" && url.pathname === "/link/v1/lock") { fields(await body(request), []); return cookie(json(200, { locked: true, revoked: false }), "", 0, true); }
      fail(404, "NOT_FOUND", "Unknown Link operation.");
    } catch (error) {
      const response = error instanceof LinkFault ? json(error.status, { error: { code: error.code, message: error.message } }) : json(503, { error: { code: "LINK_UNAVAILABLE", message: "Operation is unconfirmed. Preserve the same credential and requestId when retrying." } });
      if (response.status === 429) response.headers.set("retry-after", "2"); return response;
    }
  } };
}
