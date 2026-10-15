import { createControlProof } from "../plugin/src/protocol.mjs";
import { LinkError } from "./errors.mjs";

export const DEFAULT_RELAY_URL = "https://codex-link-relay.sarda0x.chatgpt.site";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export function normalizeRelayUrl(value) {
  let url;
  try {
    if (typeof value !== "string") throw new Error();
    url = new URL(value);
  } catch {
    throw new LinkError("INVALID_RELAY", "Configure a valid HTTPS relay URL, or HTTP on loopback for local tests.");
  }
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash ||
      !["http:", "https:"].includes(url.protocol) || (!local && url.protocol !== "https:")) {
    throw new LinkError("INVALID_RELAY", "Relay URLs cannot contain credentials, queries, or fragments; non-local relays require HTTPS.");
  }
  return url.toString().replace(/\/$/, "");
}

const RELAY_ERRORS = {
  400: ["RELAY_REJECTED", "The relay rejected this operation."],
  401: ["ROOM_ACCESS_DENIED", "The relay did not authorize this room capability."],
  403: ["ROOM_ACCESS_DENIED", "The relay did not authorize this participant operation."],
  404: ["ROOM_NOT_FOUND", "The room was not found or has expired."],
  409: ["ROOM_CONFLICT", "The room cannot accept this operation; check membership, capacity, and whether a peer has joined."],
  429: ["RELAY_LIMIT", "A relay rate or queue limit was reached. Do not retry automatically."],
};

async function readJson(response) {
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) throw new Error();
  const reader = response.body?.getReader();
  if (!reader) throw new Error();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error();
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function createTransport(relayUrl) {
  const base = normalizeRelayUrl(relayUrl);

  async function request(path, capability, { method = "GET", body, query, waitMs = 0 } = {}) {
    const url = new URL(`${base}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, String(value));
    const headers = { accept: "application/json", authorization: `Bearer ${capability}` };
    if (body !== undefined) headers["content-type"] = "application/json";
    try {
      const response = await fetch(url, {
        method, headers, redirect: "error",
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(Math.max(10_000, waitMs + 2_000)),
      });
      if (!response.ok) {
        // Do not parse/echo an error body controlled by the relay.
        await response.body?.cancel();
        const known = RELAY_ERRORS[response.status];
        throw new LinkError(known?.[0] ?? "RELAY_UNAVAILABLE", known?.[1] ?? "The relay could not complete this operation.",
          known ? response.status : 502);
      }
      return await readJson(response);
    } catch (error) {
      if (error instanceof LinkError) throw error;
      throw new LinkError("RELAY_UNAVAILABLE", "The relay response was unavailable or invalid. No automatic retry was made.", 502);
    }
  }

  function control(action, session, body) {
    return { ...body, controlProof: createControlProof(action, session.invitation.roomId, body, session.identity) };
  }

  const roomPath = (session) => `/v1/rooms/${session.invitation.roomId}`;
  return {
    register(session, owner) {
      const body = { participantId: session.identity.participantId, protocolVersion: 2, publicKey: session.identity.publicKey };
      if (owner) body.roomId = session.invitation.roomId;
      return request(owner ? "/v1/rooms" : `${roomPath(session)}/join`, session.capability, {
        method: "POST", body: control(owner ? "create" : "join", session, body),
      });
    },
    status(session) {
      return request(`${roomPath(session)}/status`, session.capability, { query: { participantId: session.identity.participantId } });
    },
    send(session, envelope) {
      return request(`${roomPath(session)}/messages`, session.capability, { method: "POST", body: envelope });
    },
    receive(session, waitMs) {
      return request(`${roomPath(session)}/messages`, session.capability, {
        query: { participantId: session.identity.participantId, waitMs }, waitMs,
      });
    },
    ack(session, messageIds) {
      return request(`${roomPath(session)}/acks`, session.capability, {
        method: "POST", body: control("acks", session, { participantId: session.identity.participantId, messageIds }),
      });
    },
    disconnect(session) {
      return request(session.isOwner ? roomPath(session) : `${roomPath(session)}/leave`, session.capability, {
        method: session.isOwner ? "DELETE" : "POST",
        body: control(session.isOwner ? "close" : "leave", session, { participantId: session.identity.participantId }),
      });
    },
  };
}
