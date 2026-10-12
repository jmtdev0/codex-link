const ROOM_ID = /^[A-Za-z0-9_-]{22}$/;
const PARTICIPANT_ID = /^[A-Za-z0-9_-]{22}$/;
const MESSAGE_ID = /^[A-Za-z0-9_-]{22}$/;
const ROOM_CAPABILITY = /^[A-Za-z0-9_-]{43}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const MAX_ROOM_PARTICIPANTS = 8;
const ROOM_TTL_MS = 24 * 60 * 60 * 1000;
const MESSAGE_TTL_MS = 5 * 60 * 1000;
const MAX_BODY_BYTES = 24 * 1024;
const MAX_PENDING = 100;
const MAX_ACTIVE_ROOMS = 500;
const MAX_ROOM_CREATES_PER_IP = 8;
const MAX_ROOM_REQUESTS_PER_MINUTE = 300;
const CREATE_RATE_WINDOW_MS = 10 * 60 * 1000;
const ROOM_RATE_WINDOW_MS = 60 * 1000;
const MAX_WAIT_MS = 15_000;
const WAIT_POLL_MS = 500;
const CLEANUP_INTERVAL_MS = 10_000;

class ClientError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function json(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      vary: "authorization",
    },
  });
}

function encodedLength(value) {
  if (typeof value !== "string" || !BASE64URL.test(value)) return -1;
  try {
    return atob(value.replace(/-/g, "+").replace(/_/g, "/")).length;
  } catch {
    return -1;
  }
}

function validEnvelope(value, roomId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const fields = value.v === 2
    ? ["v", "roomId", "senderId", "messageId", "nonce", "ciphertext", "tag", "publicKey", "signature"]
    : ["v", "roomId", "senderId", "messageId", "nonce", "ciphertext", "tag"];
  if (Object.keys(value).length !== fields.length || Object.keys(value).some((key) => !fields.includes(key))) return false;
  if ((value.v !== 1 && value.v !== 2) || value.roomId !== roomId) return false;
  if (!PARTICIPANT_ID.test(value.senderId) || !MESSAGE_ID.test(value.messageId)) return false;
  if (encodedLength(value.nonce) !== 12 || encodedLength(value.tag) !== 16) return false;
  const ciphertextLength = encodedLength(value.ciphertext);
  if (value.v === 2 && (encodedLength(value.publicKey) !== 44 || encodedLength(value.signature) !== 64)) return false;
  return ciphertextLength > 0 && ciphertextLength <= 9 * 1024;
}

function decodeBase64Url(value) {
  return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), (char) => char.charCodeAt(0));
}

function encodeBase64Url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function identityParticipantId(publicKey) {
  if (encodedLength(publicKey) !== 44) return null;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", decodeBase64Url(publicKey)));
  return encodeBase64Url(digest.slice(0, 16));
}

function changes(result) {
  return Number(result?.meta?.changes ?? result?.changes ?? 0);
}

function hex(bytes) {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return hex(digest);
}

async function hmacHex(secret, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

function readRoomCapability(request) {
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.get("authorization") ?? "");
  if (!match || !ROOM_CAPABILITY.test(match[1])) {
    throw new ClientError(401, "A valid room capability is required.");
  }
  return match[1];
}

function equalDigest(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function first(db, sql, ...values) {
  return db.prepare(sql).bind(...values).first();
}

async function run(db, sql, ...values) {
  return db.prepare(sql).bind(...values).run();
}

export function createSitesRelay({
  roomTtlMs = ROOM_TTL_MS,
  messageTtlMs = MESSAGE_TTL_MS,
  maxPending = MAX_PENDING,
  maxActiveRooms = MAX_ACTIVE_ROOMS,
  maxRoomCreatesPerIp = MAX_ROOM_CREATES_PER_IP,
  maxRoomRequestsPerMinute = MAX_ROOM_REQUESTS_PER_MINUTE,
  waitPollMs = WAIT_POLL_MS,
  cleanupIntervalMs = CLEANUP_INTERVAL_MS,
} = {}) {
  let lastCleanupAt = 0;
  let cleanupInFlight;

  async function cleanupExpired(db) {
    const now = Date.now();
    if (cleanupInFlight) return cleanupInFlight;
    if (now - lastCleanupAt < cleanupIntervalMs) return;

    cleanupInFlight = db.batch([
      db.prepare("DELETE FROM codex_link_messages WHERE expires_at <= ?").bind(now),
      db.prepare("DELETE FROM codex_link_rooms WHERE expires_at <= ?").bind(now),
      db.prepare("DELETE FROM codex_link_rate_limits WHERE window_started_at <= ?").bind(now - 24 * 60 * 60 * 1000),
    ]);
    try {
      await cleanupInFlight;
      lastCleanupAt = now;
    } finally {
      cleanupInFlight = undefined;
    }
  }

  async function readJson(request) {
    const reader = request.body?.getReader();
    if (!reader) throw new ClientError(400, "Request body must be JSON.");
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BODY_BYTES) {
          await reader.cancel().catch(() => {});
          throw new ClientError(413, "Request body too large.");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let raw;
    try {
      raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new ClientError(400, "Request body must be valid UTF-8.");
    }
    try {
      return JSON.parse(raw);
    } catch {
      throw new ClientError(400, "Request body must be JSON.");
    }
  }

  async function getLiveRoom(db, roomId) {
    const room = await first(
      db,
      "SELECT room_id, owner_id, peer_id, capability_hash, expires_at, protocol_version FROM codex_link_rooms WHERE room_id = ? AND expires_at > ?",
      roomId,
      Date.now(),
    );
    return room ?? null;
  }

  async function consumeRateLimit(db, bucketKey, now, windowMs, limit, message) {
    const result = await first(
      db,
      `INSERT INTO codex_link_rate_limits (bucket_key, window_started_at, request_count)
       VALUES (?, ?, 1)
       ON CONFLICT(bucket_key) DO UPDATE SET
         window_started_at = CASE
           WHEN codex_link_rate_limits.window_started_at <= ? THEN excluded.window_started_at
           ELSE codex_link_rate_limits.window_started_at
         END,
         request_count = CASE
           WHEN codex_link_rate_limits.window_started_at <= ? THEN 1
           ELSE codex_link_rate_limits.request_count + 1
         END
       RETURNING request_count`,
      bucketKey,
      now,
      now - windowMs,
      now - windowMs,
    );
    if (!result || Number(result.request_count) > limit) throw new ClientError(429, message);
  }

  async function readParticipants(db, roomId) {
    const result = await db.prepare(
      "SELECT participant_id AS participantId, role, public_key AS publicKey FROM codex_link_room_members WHERE room_id = ? ORDER BY joined_at, participant_id",
    ).bind(roomId).all();
    return result?.results ?? [];
  }

  async function readPending(db, roomId, participantId, limit) {
    const rows = await db.prepare(
      `SELECT envelope_json FROM codex_link_messages
       WHERE room_id = ? AND recipient_id = ? AND expires_at > ?
       ORDER BY created_at, message_id LIMIT ?`,
    ).bind(roomId, participantId, Date.now(), limit).all();
    return (rows?.results ?? []).flatMap((row) => {
      try {
        const envelope = JSON.parse(row.envelope_json);
        return validEnvelope(envelope, roomId) ? [envelope] : [];
      } catch {
        return [];
      }
    });
  }

  async function waitForAbortableDelay(request, delayMs) {
    if (request.signal.aborted) return;
    await new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        request.signal.removeEventListener("abort", finish);
        resolve();
      };
      const timer = setTimeout(finish, delayMs);
      request.signal.addEventListener("abort", finish, { once: true });
    });
  }

  async function fetchHandler(request, env = {}) {
    const db = env.DB;
    if (!db || typeof db.prepare !== "function" || typeof db.batch !== "function") {
      return json(503, { error: "Relay storage is unavailable." });
    }
    const rateLimitKey = env.CODEX_LINK_RATE_LIMIT_KEY;
    if (typeof rateLimitKey !== "string" || rateLimitKey.length < 32) {
      return json(503, { error: "Relay protections are unavailable." });
    }

    try {
      await cleanupExpired(db);
      const url = new URL(request.url);
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts[0] !== "v1" || parts[1] !== "rooms") return json(404, { error: "Not found." });

      if (parts.length === 2 && request.method === "POST") {
        const capability = readRoomCapability(request);
        const body = await readJson(request);
        const protocolVersion = body?.protocolVersion ?? 1;
        if (!ROOM_ID.test(body?.roomId ?? "") || !PARTICIPANT_ID.test(body?.participantId ?? "") ||
            (protocolVersion !== 1 && protocolVersion !== 2)) {
          throw new ClientError(400, "Invalid room or participant ID.");
        }
        if (protocolVersion === 2 && await identityParticipantId(body?.publicKey) !== body.participantId) {
          throw new ClientError(400, "The participant ID does not match its signing public key.");
        }
        if (protocolVersion === 1 && body?.publicKey !== undefined) {
          throw new ClientError(400, "Legacy rooms cannot register a signing public key.");
        }
        const now = Date.now();
        const clientIp = request.headers.get("cf-connecting-ip")?.trim();
        if (!clientIp || clientIp.length > 128) throw new ClientError(503, "Request could not be rate-limited.");
        const ipBucket = `create:${await hmacHex(rateLimitKey, clientIp)}`;
        await consumeRateLimit(
          db,
          ipBucket,
          now,
          CREATE_RATE_WINDOW_MS,
          maxRoomCreatesPerIp,
          "Too many room invitations from this network. Try again later.",
        );
        const expiresAt = now + roomTtlMs;
        const capabilityHash = await sha256Hex(capability);
        await run(
          db,
          "DELETE FROM codex_link_rooms WHERE room_id = ? AND expires_at <= ?",
          body.roomId,
          now,
        );
        const [inserted] = await db.batch([
          db.prepare(
            `INSERT INTO codex_link_rooms (room_id, owner_id, peer_id, expires_at, capability_hash, protocol_version)
             SELECT ?, ?, NULL, ?, ?, ?
             WHERE (SELECT COUNT(*) FROM codex_link_rooms WHERE expires_at > ?) < ?`,
          ).bind(body.roomId, body.participantId, expiresAt, capabilityHash, protocolVersion, now, maxActiveRooms),
          db.prepare(
            `INSERT INTO codex_link_room_members (room_id, participant_id, role, public_key, joined_at)
             SELECT ?, ?, 'owner', ?, ? WHERE EXISTS (SELECT 1 FROM codex_link_rooms WHERE room_id = ?)`
          ).bind(body.roomId, body.participantId, body.publicKey ?? null, now, body.roomId),
        ]);
        if (changes(inserted) === 0) {
          const existing = await getLiveRoom(db, body.roomId);
          if (existing) return json(409, { error: "Room already exists." });
          return json(429, { error: "Relay room capacity reached. Try again later." });
        }
        return json(201, {
          expiresAt: new Date(expiresAt).toISOString(),
          participantCount: 1,
          protocolVersion,
        });
      }

      const roomId = parts[2];
      if (!ROOM_ID.test(roomId ?? "")) throw new ClientError(400, "Invalid room ID.");
      const capability = readRoomCapability(request);
      const capabilityHash = await sha256Hex(capability);
      const room = await getLiveRoom(db, roomId);
      if (!room || !equalDigest(room.capability_hash, capabilityHash)) return json(404, { error: "Room not found or expired." });
      const roomBucket = `room:${await hmacHex(rateLimitKey, roomId)}`;
      await consumeRateLimit(
        db,
        roomBucket,
        Date.now(),
        ROOM_RATE_WINDOW_MS,
        maxRoomRequestsPerMinute,
        "This room is sending requests too quickly. Try again shortly.",
      );

      if (parts.length === 4 && parts[3] === "join" && request.method === "POST") {
        const body = await readJson(request);
        const participantId = body?.participantId;
        if (!PARTICIPANT_ID.test(participantId ?? "")) throw new ClientError(400, "Invalid participant ID.");
        const protocolVersion = body?.protocolVersion ?? 1;
        if (protocolVersion !== room.protocol_version) {
          return json(409, { error: "The invitation uses a different protocol version." });
        }
        if (protocolVersion === 2 && await identityParticipantId(body?.publicKey) !== participantId) {
          throw new ClientError(400, "The participant ID does not match its signing public key.");
        }
        if (protocolVersion === 1 && body?.publicKey !== undefined) {
          throw new ClientError(400, "Legacy rooms cannot register a signing public key.");
        }

        const publicKey = body.publicKey ?? null;
        const existing = await first(
          db,
          "SELECT role, public_key FROM codex_link_room_members WHERE room_id = ? AND participant_id = ?",
          roomId,
          participantId,
        );
        if (existing) {
          if (existing.public_key !== publicKey) {
            return json(409, { error: "This participant ID is already bound to a different signing key." });
          }
        } else {
          const maxParticipants = protocolVersion === 2 ? MAX_ROOM_PARTICIPANTS : 2;
          const inserted = await run(
            db,
            `INSERT OR IGNORE INTO codex_link_room_members (room_id, participant_id, role, public_key, joined_at)
             SELECT ?, ?, 'member', ?, ?
             WHERE (SELECT COUNT(*) FROM codex_link_room_members WHERE room_id = ?) < ?`,
            roomId,
            participantId,
            publicKey,
            Date.now(),
            roomId,
            maxParticipants,
          );
          if (changes(inserted) === 0) return json(409, { error: `This room is full (maximum ${maxParticipants} participants).` });
          await run(
            db,
            "UPDATE codex_link_rooms SET peer_id = COALESCE(peer_id, ?) WHERE room_id = ? AND owner_id != ?",
            participantId,
            roomId,
            participantId,
          );
        }
        const participants = await readParticipants(db, roomId);
        return json(200, {
          expiresAt: new Date(room.expires_at).toISOString(),
          participantCount: participants.length,
          participants: participants.map(({ participantId, role }) => ({ participantId, role })),
          protocolVersion,
        });
      }

      if (parts.length === 4 && parts[3] === "status" && request.method === "GET") {
        const participantId = url.searchParams.get("participantId");
        const participants = await readParticipants(db, roomId);
        if (!participants.some((member) => member.participantId === participantId)) {
          return json(403, { error: "Participant is not in this room." });
        }
        return json(200, {
          participantCount: participants.length,
          participants: participants.map(({ participantId, role }) => ({ participantId, role })),
          protocolVersion: room.protocol_version,
          maxParticipants: room.protocol_version === 2 ? MAX_ROOM_PARTICIPANTS : 2,
          expiresAt: new Date(room.expires_at).toISOString(),
        });
      }

      if (parts.length === 4 && parts[3] === "messages" && request.method === "POST") {
        const envelope = await readJson(request);
        const participants = await readParticipants(db, roomId);
        const sender = participants.find((member) => member.participantId === envelope?.senderId);
        if (!validEnvelope(envelope, roomId) || !sender || envelope.v !== room.protocol_version ||
            (room.protocol_version === 2 && envelope.publicKey !== sender.publicKey)) {
          throw new ClientError(400, "Invalid encrypted envelope or sender.");
        }
        if (participants.length < 2) return json(409, { error: "No other participant has joined yet." });
        const now = Date.now();
        const expiresAt = now + messageTtlMs;
        const recipients = participants.filter((member) => member.participantId !== envelope.senderId);
        const fullRecipient = await first(
          db,
          `SELECT member.participant_id FROM codex_link_room_members AS member
           WHERE member.room_id = ? AND member.participant_id != ?
             AND (SELECT COUNT(*) FROM codex_link_messages AS queued
                  WHERE queued.room_id = member.room_id AND queued.recipient_id = member.participant_id
                    AND queued.expires_at > ?) >= ?
             AND NOT EXISTS (SELECT 1 FROM codex_link_messages AS prior
                             WHERE prior.room_id = member.room_id AND prior.recipient_id = member.participant_id
                               AND prior.message_id = ?)
           LIMIT 1`,
          roomId,
          envelope.senderId,
          now,
          maxPending,
          envelope.messageId,
        );
        if (fullRecipient) return json(429, { error: "A participant queue is full; retry this message later." });
        const results = await db.batch(recipients.map((recipient) => db.prepare(
          `INSERT OR IGNORE INTO codex_link_messages
           (room_id, recipient_id, sender_id, message_id, envelope_json, created_at, expires_at)
           SELECT ?, ?, ?, ?, ?, ?, ?
           WHERE (SELECT COUNT(*) FROM codex_link_messages
                  WHERE room_id = ? AND recipient_id = ? AND expires_at > ?) < ?`,
        ).bind(
          roomId,
          recipient.participantId,
          envelope.senderId,
          envelope.messageId,
          JSON.stringify(envelope),
          now,
          expiresAt,
          roomId,
          recipient.participantId,
          now,
          maxPending,
        )));
        for (const [index, inserted] of results.entries()) {
          if (changes(inserted) === 0) {
            const duplicate = await first(
              db,
              "SELECT message_id FROM codex_link_messages WHERE room_id = ? AND recipient_id = ? AND message_id = ?",
              roomId,
              recipients[index].participantId,
              envelope.messageId,
            );
            if (!duplicate) return json(429, { error: "A participant queue is full; retry this message later." });
          }
        }
        return json(202, { accepted: true });
      }

      if (parts.length === 4 && parts[3] === "messages" && request.method === "GET") {
        const participantId = url.searchParams.get("participantId");
        const participants = await readParticipants(db, roomId);
        if (!participants.some((member) => member.participantId === participantId)) {
          return json(403, { error: "Participant is not in this room." });
        }
        const waitMs = Math.min(Math.max(Number(url.searchParams.get("waitMs") ?? 0) || 0, 0), MAX_WAIT_MS);
        const deadline = Date.now() + waitMs;
        let messages = await readPending(db, roomId, participantId, maxPending);
        while (!messages.length && Date.now() < deadline && !request.signal.aborted) {
          await waitForAbortableDelay(request, Math.min(waitPollMs, deadline - Date.now()));
          if (!request.signal.aborted) messages = await readPending(db, roomId, participantId, maxPending);
        }
        return json(200, { messages });
      }

      if (parts.length === 4 && parts[3] === "acks" && request.method === "POST") {
        const body = await readJson(request);
        const participants = await readParticipants(db, roomId);
        if (!participants.some((member) => member.participantId === body?.participantId)) {
          return json(403, { error: "Participant is not in this room." });
        }
        const requestedIds = Array.isArray(body?.messageIds) ? body.messageIds : [];
        if (requestedIds.length > maxPending || requestedIds.some((id) => !MESSAGE_ID.test(id))) {
          throw new ClientError(400, "Invalid message IDs.");
        }
        const messageIds = [...new Set(requestedIds)];
        if (!messageIds.length) return json(200, { acknowledged: 0 });
        const placeholders = messageIds.map(() => "?").join(", ");
        const result = await run(
          db,
          `DELETE FROM codex_link_messages WHERE room_id = ? AND recipient_id = ? AND message_id IN (${placeholders})`,
          roomId,
          body.participantId,
          ...messageIds,
        );
        return json(200, { acknowledged: changes(result) });
      }

      if (parts.length === 4 && parts[3] === "leave" && request.method === "POST") {
        const body = await readJson(request);
        const participant = (await readParticipants(db, roomId))
          .find((member) => member.participantId === body?.participantId);
        if (!participant) return json(403, { error: "Participant is not in this room." });
        if (participant.role === "owner") return json(409, { error: "The room owner must close the room instead of leaving it." });
        await db.batch([
          db.prepare("DELETE FROM codex_link_messages WHERE room_id = ? AND recipient_id = ?")
            .bind(roomId, body.participantId),
          db.prepare("DELETE FROM codex_link_room_members WHERE room_id = ? AND participant_id = ?")
            .bind(roomId, body.participantId),
          db.prepare("UPDATE codex_link_rooms SET peer_id = NULL WHERE room_id = ? AND peer_id = ?")
            .bind(roomId, body.participantId),
        ]);
        return json(200, { left: true });
      }

      if (parts.length === 3 && request.method === "DELETE") {
        const body = await readJson(request);
        const participants = await readParticipants(db, roomId);
        if (!participants.some((member) => member.participantId === body?.participantId)) {
          return json(403, { error: "Participant is not in this room." });
        }
        if (room.protocol_version === 2 && body.participantId !== room.owner_id) {
          return json(403, { error: "Only the room owner can close this group room. Other participants should leave." });
        }
        await run(db, "DELETE FROM codex_link_rooms WHERE room_id = ?", roomId);
        return json(200, { closed: true });
      }

      return json(404, { error: "Not found." });
    } catch (error) {
      if (error instanceof ClientError) return json(error.status, { error: error.message });
      return json(503, { error: "Relay storage is temporarily unavailable." });
    }
  }

  return { fetch: fetchHandler };
}

const relay = createSitesRelay();

export default {
  fetch(request, env) {
    return relay.fetch(request, env);
  },
};
