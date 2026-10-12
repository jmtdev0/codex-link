import http from "node:http";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyControlProof } from "../plugin/src/protocol.mjs";

const ROOM_ID = /^[A-Za-z0-9_-]{22}$/;
const PARTICIPANT_ID = /^[A-Za-z0-9_-]{22}$/;
const MESSAGE_ID = /^[A-Za-z0-9_-]{22}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const MAX_ROOM_PARTICIPANTS = 8;
const ROOM_TTL_MS = 24 * 60 * 60 * 1000;
const MESSAGE_TTL_MS = 5 * 60 * 1000;
const MAX_BODY_BYTES = 24 * 1024;
const MAX_PENDING = 100;

function json(response, status, data) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(data));
}

async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body too large.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Request body must be JSON.");
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
  if (!BASE64URL.test(value.nonce) || Buffer.from(value.nonce, "base64url").length !== 12) return false;
  if (!BASE64URL.test(value.tag) || Buffer.from(value.tag, "base64url").length !== 16) return false;
  if (!BASE64URL.test(value.ciphertext) || Buffer.from(value.ciphertext, "base64url").length > 9 * 1024) return false;
  if (value.v === 2 && (!BASE64URL.test(value.publicKey) || Buffer.from(value.publicKey, "base64url").length !== 44 ||
      !BASE64URL.test(value.signature) || Buffer.from(value.signature, "base64url").length !== 64)) return false;
  return true;
}

function identityParticipantId(publicKey) {
  if (!BASE64URL.test(publicKey ?? "")) return null;
  const bytes = Buffer.from(publicKey, "base64url");
  if (bytes.length !== 44) return null;
  return createHash("sha256").update(bytes).digest().subarray(0, 16).toString("base64url");
}

export function createRelayServer({
  host = "127.0.0.1",
  port = 8787,
  accessToken = "",
  roomTtlMs = ROOM_TTL_MS,
  messageTtlMs = MESSAGE_TTL_MS,
  maxPending = MAX_PENDING,
} = {}) {
  if (!new Set(["127.0.0.1", "localhost", "::1"]).has(host) && !accessToken) {
    throw new Error("A relay exposed beyond loopback requires an explicit access token.");
  }
  const rooms = new Map();

  function removeExpired() {
    const now = Date.now();
    for (const [roomId, room] of rooms) {
      if (room.expiresAt <= now) {
        rooms.delete(roomId);
        continue;
      }
      for (const [participantId, queue] of room.queues) {
        for (const [messageId, item] of queue) {
          if (item.expiresAt <= now) queue.delete(messageId);
        }
        if (!room.participants.has(participantId)) room.queues.delete(participantId);
      }
    }
  }

  const server = http.createServer(async (request, response) => {
    if (request.url === "/health" && request.method === "GET") return json(response, 200, { ok: true });
    if (accessToken && request.headers.authorization !== `Bearer ${accessToken}`) {
      return json(response, 401, { error: "Unauthorized." });
    }

    removeExpired();
    const url = new URL(request.url, `http://${request.headers.host ?? "localhost"}`);
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "v1" || parts[1] !== "rooms") return json(response, 404, { error: "Not found." });

    try {
      if (parts.length === 2 && request.method === "POST") {
        const body = await readBody(request);
        if (!ROOM_ID.test(body?.roomId ?? "") || !PARTICIPANT_ID.test(body?.participantId ?? "")) {
          return json(response, 400, { error: "Invalid room or participant ID." });
        }
        const protocolVersion = body.protocolVersion ?? 1;
        if ((protocolVersion !== 1 && protocolVersion !== 2) ||
            (protocolVersion === 2 && identityParticipantId(body.publicKey) !== body.participantId) ||
            (protocolVersion === 1 && body.publicKey !== undefined)) {
          return json(response, 400, { error: "Invalid protocol version or signing identity." });
        }
        if (protocolVersion === 2 && !verifyControlProof("create", body.roomId, body, body.publicKey)) {
          return json(response, 403, { error: "A valid participant control signature is required. Update Codex Link." });
        }
        if (rooms.has(body.roomId)) return json(response, 409, { error: "Room already exists." });
        const room = {
          expiresAt: Date.now() + roomTtlMs,
          protocolVersion,
          ownerId: body.participantId,
          participants: new Set([body.participantId]),
          publicKeys: new Map([[body.participantId, body.publicKey ?? null]]),
          queues: new Map([[body.participantId, new Map()]]),
          waiters: new Map(),
        };
        rooms.set(body.roomId, room);
        return json(response, 201, { expiresAt: new Date(room.expiresAt).toISOString(), participantCount: 1, protocolVersion });
      }

      const roomId = parts[2];
      if (!ROOM_ID.test(roomId ?? "")) return json(response, 400, { error: "Invalid room ID." });
      const room = rooms.get(roomId);
      if (!room) return json(response, 404, { error: "Room not found or expired." });

      if (parts.length === 4 && parts[3] === "join" && request.method === "POST") {
        const body = await readBody(request);
        const participantId = body?.participantId;
        if (!PARTICIPANT_ID.test(participantId ?? "")) return json(response, 400, { error: "Invalid participant ID." });
        const protocolVersion = body.protocolVersion ?? 1;
        if (protocolVersion !== room.protocolVersion ||
            (protocolVersion === 2 && identityParticipantId(body.publicKey) !== participantId) ||
            (protocolVersion === 1 && body.publicKey !== undefined)) {
          return json(response, 409, { error: "Invalid protocol version or signing identity for this room." });
        }
        if (protocolVersion === 2 && !verifyControlProof("join", roomId, body, body.publicKey)) {
          return json(response, 403, { error: "A valid participant control signature is required. Update Codex Link." });
        }
        const existingPublicKey = room.publicKeys.get(participantId);
        if (room.participants.has(participantId) && existingPublicKey !== (body.publicKey ?? null)) {
          return json(response, 409, { error: "This participant ID is bound to another signing key." });
        }
        const maxParticipants = room.protocolVersion === 2 ? MAX_ROOM_PARTICIPANTS : 2;
        if (!room.participants.has(participantId) && room.participants.size >= maxParticipants) {
          return json(response, 409, { error: `This room is full (maximum ${maxParticipants} participants).` });
        }
        room.participants.add(participantId);
        room.publicKeys.set(participantId, body.publicKey ?? null);
        room.queues.set(participantId, room.queues.get(participantId) ?? new Map());
        return json(response, 200, { expiresAt: new Date(room.expiresAt).toISOString(), participantCount: room.participants.size, participants: [...room.participants], protocolVersion });
      }

      if (parts.length === 4 && parts[3] === "status" && request.method === "GET") {
        const participantId = url.searchParams.get("participantId");
        if (!room.participants.has(participantId)) return json(response, 403, { error: "Participant is not in this room." });
        return json(response, 200, {
          participantCount: room.participants.size,
          participants: [...room.participants],
          protocolVersion: room.protocolVersion,
          maxParticipants: room.protocolVersion === 2 ? MAX_ROOM_PARTICIPANTS : 2,
          expiresAt: new Date(room.expiresAt).toISOString(),
        });
      }

      if (parts.length === 4 && parts[3] === "messages" && request.method === "POST") {
        const envelope = await readBody(request);
        if (!validEnvelope(envelope, roomId) || envelope.v !== room.protocolVersion ||
            !room.participants.has(envelope.senderId) ||
            (room.protocolVersion === 2 && room.publicKeys.get(envelope.senderId) !== envelope.publicKey)) {
          return json(response, 400, { error: "Invalid encrypted envelope or sender." });
        }
        if (room.participants.size < 2) return json(response, 409, { error: "No other participant has joined yet." });
        const recipients = [...room.participants].filter((id) => id !== envelope.senderId);
        if (recipients.some((recipientId) => {
          const queue = room.queues.get(recipientId);
          return queue.size >= maxPending && !queue.has(envelope.messageId);
        })) {
          return json(response, 429, { error: "A participant queue is full; retry this message later." });
        }
        for (const recipientId of recipients) {
          const queue = room.queues.get(recipientId);
          queue.set(envelope.messageId, { envelope, expiresAt: Date.now() + messageTtlMs });
          for (const wake of room.waiters.get(recipientId) ?? []) wake();
        }
        return json(response, 202, { accepted: true });
      }

      if (parts.length === 4 && parts[3] === "messages" && request.method === "GET") {
        const participantId = url.searchParams.get("participantId");
        if (!room.participants.has(participantId)) return json(response, 403, { error: "Participant is not in this room." });
        const queue = room.queues.get(participantId);
        const waitMs = Math.min(Math.max(Number(url.searchParams.get("waitMs") ?? 0) || 0, 0), 15_000);
        if (queue.size === 0 && waitMs > 0) {
          await new Promise((resolve) => {
            const timer = setTimeout(() => finish(), waitMs);
            const waiters = room.waiters.get(participantId) ?? new Set();
            room.waiters.set(participantId, waiters);
            const wake = () => finish();
            function finish() {
              clearTimeout(timer);
              waiters.delete(wake);
              resolve();
            }
            waiters.add(wake);
          });
        }
        const now = Date.now();
        const messages = [...queue.values()]
          .filter((item) => item.expiresAt > now)
          .slice(0, maxPending)
          .map((item) => item.envelope);
        return json(response, 200, { messages });
      }

      if (parts.length === 4 && parts[3] === "acks" && request.method === "POST") {
        const body = await readBody(request);
        const queue = room.queues.get(body?.participantId);
        if (!queue) return json(response, 403, { error: "Participant is not in this room." });
        if (room.protocolVersion === 2 && !verifyControlProof("acks", roomId, body, room.publicKeys.get(body.participantId))) {
          return json(response, 403, { error: "A valid participant control signature is required. Update Codex Link." });
        }
        const messageIds = Array.isArray(body?.messageIds) ? body.messageIds : [];
        for (const id of messageIds) if (MESSAGE_ID.test(id)) queue.delete(id);
        return json(response, 200, { acknowledged: messageIds.length });
      }

      if (parts.length === 4 && parts[3] === "leave" && request.method === "POST") {
        const body = await readBody(request);
        if (!room.participants.has(body?.participantId)) return json(response, 403, { error: "Participant is not in this room." });
        if (room.protocolVersion === 2 && !verifyControlProof("leave", roomId, body, room.publicKeys.get(body.participantId))) {
          return json(response, 403, { error: "A valid participant control signature is required. Update Codex Link." });
        }
        if (body.participantId === room.ownerId) {
          return json(response, 409, { error: "The room owner must close the room instead of leaving it." });
        }
        room.participants.delete(body.participantId);
        room.publicKeys.delete(body.participantId);
        room.queues.delete(body.participantId);
        for (const wake of room.waiters.get(body.participantId) ?? []) wake();
        room.waiters.delete(body.participantId);
        return json(response, 200, { left: true });
      }

      if (parts.length === 3 && request.method === "DELETE") {
        const body = await readBody(request);
        if (!room.participants.has(body?.participantId)) return json(response, 403, { error: "Participant is not in this room." });
        if (room.protocolVersion === 2 && !verifyControlProof("close", roomId, body, room.publicKeys.get(body.participantId))) {
          return json(response, 403, { error: "A valid participant control signature is required. Update Codex Link." });
        }
        if (room.protocolVersion === 2 && body.participantId !== room.ownerId) {
          return json(response, 403, { error: "Only the room owner can close this group room. Other participants should leave." });
        }
        rooms.delete(roomId);
        for (const waiters of room.waiters.values()) for (const wake of waiters) wake();
        return json(response, 200, { closed: true });
      }

      return json(response, 404, { error: "Not found." });
    } catch (error) {
      if (!response.headersSent) return json(response, 400, { error: error instanceof Error ? error.message : "Invalid request." });
      response.destroy();
    }
  });

  return {
    server,
    rooms,
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.removeListener("error", reject);
          resolve(server.address());
        });
      });
    },
    async close() {
      for (const room of rooms.values()) {
        for (const waiters of room.waiters.values()) for (const wake of waiters) wake();
      }
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const port = Number(process.env.CODEX_LINK_RELAY_PORT ?? 8787);
  const relay = createRelayServer({ host: "127.0.0.1", port });
  const address = await relay.listen();
  process.stdout.write(`Codex Link development relay listening at http://127.0.0.1:${address.port}\n`);
  process.stdout.write("Room queues live only in this process's RAM; no message content is logged or written to disk.\n");
  const stop = async () => {
    await relay.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
