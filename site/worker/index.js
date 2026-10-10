const ROOM_ID = /^[A-Za-z0-9_-]{22}$/;
const PARTICIPANT_ID = /^[A-Za-z0-9_-]{22}$/;
const MESSAGE_ID = /^[A-Za-z0-9_-]{22}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const ROOM_TTL_MS = 30 * 60 * 1000;
const MESSAGE_TTL_MS = 5 * 60 * 1000;
const MAX_BODY_BYTES = 24 * 1024;
const MAX_PENDING = 100;
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
  const fields = ["v", "roomId", "senderId", "messageId", "nonce", "ciphertext", "tag"];
  if (Object.keys(value).length !== fields.length || Object.keys(value).some((key) => !fields.includes(key))) return false;
  if (value.v !== 1 || value.roomId !== roomId) return false;
  if (!PARTICIPANT_ID.test(value.senderId) || !MESSAGE_ID.test(value.messageId)) return false;
  if (encodedLength(value.nonce) !== 12 || encodedLength(value.tag) !== 16) return false;
  const ciphertextLength = encodedLength(value.ciphertext);
  return ciphertextLength > 0 && ciphertextLength <= 9 * 1024;
}

function changes(result) {
  return Number(result?.meta?.changes ?? result?.changes ?? 0);
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
      "SELECT room_id, owner_id, peer_id, expires_at FROM codex_link_rooms WHERE room_id = ? AND expires_at > ?",
      roomId,
      Date.now(),
    );
    return room ?? null;
  }

  function participantIds(room) {
    return [room.owner_id, room.peer_id].filter(Boolean);
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
    const token = env.CODEX_LINK_ACCESS_TOKEN;
    if (typeof token !== "string" || token.length < 32 || request.headers.get("authorization") !== `Bearer ${token}`) {
      return json(401, { error: "Unauthorized." });
    }
    const db = env.DB;
    if (!db || typeof db.prepare !== "function" || typeof db.batch !== "function") {
      return json(503, { error: "Relay storage is unavailable." });
    }

    try {
      await cleanupExpired(db);
      const url = new URL(request.url);
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts[0] !== "v1" || parts[1] !== "rooms") return json(404, { error: "Not found." });

      if (parts.length === 2 && request.method === "POST") {
        const body = await readJson(request);
        if (!ROOM_ID.test(body?.roomId ?? "") || !PARTICIPANT_ID.test(body?.participantId ?? "")) {
          throw new ClientError(400, "Invalid room or participant ID.");
        }
        const now = Date.now();
        const expiresAt = now + roomTtlMs;
        await run(
          db,
          "DELETE FROM codex_link_rooms WHERE room_id = ? AND expires_at <= ?",
          body.roomId,
          now,
        );
        try {
          await run(
            db,
            "INSERT INTO codex_link_rooms (room_id, owner_id, peer_id, expires_at) VALUES (?, ?, NULL, ?)",
            body.roomId,
            body.participantId,
            expiresAt,
          );
        } catch {
          const existing = await getLiveRoom(db, body.roomId);
          if (existing) return json(409, { error: "Room already exists." });
          throw new Error("Unable to create room.");
        }
        return json(201, { expiresAt: new Date(expiresAt).toISOString() });
      }

      const roomId = parts[2];
      if (!ROOM_ID.test(roomId ?? "")) throw new ClientError(400, "Invalid room ID.");
      const room = await getLiveRoom(db, roomId);
      if (!room) return json(404, { error: "Room not found or expired." });

      if (parts.length === 4 && parts[3] === "join" && request.method === "POST") {
        const body = await readJson(request);
        const participantId = body?.participantId;
        if (!PARTICIPANT_ID.test(participantId ?? "")) throw new ClientError(400, "Invalid participant ID.");
        if (participantId !== room.owner_id && room.peer_id && participantId !== room.peer_id) {
          return json(409, { error: "This prototype supports two participants per room." });
        }
        await run(
          db,
          "UPDATE codex_link_rooms SET peer_id = ? WHERE room_id = ? AND expires_at > ? AND (peer_id IS NULL OR peer_id = ?)",
          participantId === room.owner_id ? room.peer_id : participantId,
          roomId,
          Date.now(),
          participantId,
        );
        const joined = await getLiveRoom(db, roomId);
        if (!joined) return json(404, { error: "Room not found or expired." });
        if (!participantIds(joined).includes(participantId)) {
          return json(409, { error: "This prototype supports two participants per room." });
        }
        return json(200, {
          expiresAt: new Date(joined.expires_at).toISOString(),
          participantCount: participantIds(joined).length,
        });
      }

      if (parts.length === 4 && parts[3] === "status" && request.method === "GET") {
        const participantId = url.searchParams.get("participantId");
        if (!participantIds(room).includes(participantId)) return json(403, { error: "Participant is not in this room." });
        return json(200, { participantCount: participantIds(room).length, expiresAt: new Date(room.expires_at).toISOString() });
      }

      if (parts.length === 4 && parts[3] === "messages" && request.method === "POST") {
        const envelope = await readJson(request);
        if (!validEnvelope(envelope, roomId) || !participantIds(room).includes(envelope.senderId)) {
          throw new ClientError(400, "Invalid encrypted envelope or sender.");
        }
        if (!room.peer_id) return json(409, { error: "The peer has not joined yet." });
        const recipientId = envelope.senderId === room.owner_id ? room.peer_id : room.owner_id;
        const now = Date.now();
        const expiresAt = now + messageTtlMs;
        const inserted = await run(
          db,
          `INSERT OR IGNORE INTO codex_link_messages
           (room_id, recipient_id, sender_id, message_id, envelope_json, created_at, expires_at)
           SELECT ?, ?, ?, ?, ?, ?, ?
           WHERE (SELECT COUNT(*) FROM codex_link_messages
                  WHERE room_id = ? AND recipient_id = ? AND expires_at > ?) < ?`,
          roomId,
          recipientId,
          envelope.senderId,
          envelope.messageId,
          JSON.stringify(envelope),
          now,
          expiresAt,
          roomId,
          recipientId,
          now,
          maxPending,
        );
        if (changes(inserted) === 0) {
          const duplicate = await first(
            db,
            "SELECT message_id FROM codex_link_messages WHERE room_id = ? AND recipient_id = ? AND message_id = ?",
            roomId,
            recipientId,
            envelope.messageId,
          );
          if (!duplicate) return json(429, { error: "Recipient queue is full." });
        }
        return json(202, { accepted: true });
      }

      if (parts.length === 4 && parts[3] === "messages" && request.method === "GET") {
        const participantId = url.searchParams.get("participantId");
        if (!participantIds(room).includes(participantId)) return json(403, { error: "Participant is not in this room." });
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
        if (!participantIds(room).includes(body?.participantId)) {
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

      if (parts.length === 3 && request.method === "DELETE") {
        const body = await readJson(request);
        if (!participantIds(room).includes(body?.participantId)) {
          return json(403, { error: "Participant is not in this room." });
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
