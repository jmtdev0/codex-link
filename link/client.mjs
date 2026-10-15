import { createHash } from "node:crypto";
import {
  createIdentity, createInvitation, parseInvitation, deriveRoomCapability,
  encryptMessage, decryptMessagePayload, normalizeDisplayName, randomId,
} from "../plugin/src/protocol.mjs";
import { DEFAULT_RELAY_URL, createTransport, normalizeRelayUrl } from "./transport.mjs";
import { LinkError, fields } from "./errors.mjs";

export { LinkError } from "./errors.mjs";
export const LINK_API_VERSION = "1.0";
export const LINK_CLIENT_VERSION = "0.8.0";
const ID = /^[A-Za-z0-9_-]{22}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,80}$/;
const MAX_SESSIONS = 16;
const MAX_SENDS = 1024;
const MAX_INBOX = 100;
const MAX_WAIT_MS = 15_000;
const RECEIPT = "[[codex-link-receipt:v1]]";
const SEND_TYPES = ["message", "agent_ack", "agent_progress", "agent_reply"];

function invalid(message) { throw new LinkError("INVALID_INPUT", message); }

function expiry(value) {
  const time = typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isSafeInteger(time) || time <= Date.now() || time > Date.now() + 24 * 60 * 60 * 1000 + 60_000) {
    throw new LinkError("INVALID_RELAY_RESPONSE", "The relay returned an invalid room expiry.", 502);
  }
  return time;
}

function label(value = "") {
  try { return normalizeDisplayName(value); }
  catch { return invalid("Display names must be at most 32 characters and cannot contain control or bidirectional formatting characters."); }
}

function publicSession(session) {
  return {
    sessionId: session.sessionId, roomId: session.invitation.roomId,
    participantId: session.identity.participantId, role: session.isOwner ? "owner" : "member",
    protocolVersion: 2, expiresAt: new Date(session.expiresAt).toISOString(),
    displayName: session.displayName,
  };
}

// No disk, model SDK, chat host, provider credentials, or automatic model turns.
// Private fields also keep JSON.stringify(client) from serializing credentials.
export class LinkClient {
  #sessions = new Map();
  #transport;
  #registrations = 0;
  #disposed = false;

  constructor({ relayUrl = DEFAULT_RELAY_URL } = {}) {
    this.relayUrl = normalizeRelayUrl(relayUrl);
    this.#transport = createTransport(this.relayUrl);
  }

  async #register(invitation, displayName, isOwner) {
    if (this.#disposed) throw new LinkError("CLIENT_CLOSED", "This client has been disposed. Start a new client.", 410);
    for (const [id, session] of this.#sessions) if (session.expiresAt <= Date.now()) this.#sessions.delete(id);
    if (this.#sessions.size + this.#registrations >= MAX_SESSIONS) {
      throw new LinkError("LOCAL_LIMIT", "At most sixteen local sessions are allowed. Disconnect one first.", 429);
    }
    this.#registrations += 1;
    try {
      const session = {
        sessionId: randomId(), invitation, displayName, isOwner, identity: createIdentity(),
        capability: deriveRoomCapability(invitation), expiresAt: 0, busy: false,
        seen: new Set(), inbox: new Map(), incomingIds: new Set(), sends: new Map(),
      };
      const response = await this.#transport.register(session, isOwner);
      session.expiresAt = expiry(response?.expiresAt);
      if (this.#disposed) throw new LinkError("CLIENT_CLOSED", "The client was disposed during registration.", 410);
      this.#sessions.set(session.sessionId, session);
      return session;
    } finally { this.#registrations -= 1; }
  }

  async createRoom(options = {}) {
    fields(options, ["displayName"]);
    const session = await this.#register(createInvitation(), label(options.displayName), true);
    // This is the only successful operation that returns a bearer invitation.
    return { ...publicSession(session), invitationCode: session.invitation.code };
  }

  async joinRoom(options) {
    fields(options, ["invitationCode", "displayName"], ["invitationCode"]);
    let invitation;
    try { invitation = parseInvitation(options.invitationCode); }
    catch { return invalid("A valid Link room invitation is required. Supply it privately, never in a URL or command argument."); }
    if (invitation.version !== 2) invalid("The generic Link client requires a signed protocol-v2 (cl2) room.");
    return publicSession(await this.#register(invitation, label(options.displayName), false));
  }

  #get(sessionId) {
    if (typeof sessionId !== "string" || !ID.test(sessionId)) invalid("A valid local session ID is required.");
    const session = this.#sessions.get(sessionId);
    if (!session) throw new LinkError("SESSION_NOT_FOUND", "Session not found in this process. Join again after a restart.", 404);
    if (session.expiresAt <= Date.now()) {
      this.#sessions.delete(sessionId);
      throw new LinkError("SESSION_EXPIRED", "This room has expired. Use a fresh invitation.", 410);
    }
    return session;
  }

  async #operation(sessionId, operation) {
    const session = this.#get(sessionId);
    if (session.busy) throw new LinkError("SESSION_BUSY", "Another operation is pending for this session. Wait for it to finish.", 409);
    session.busy = true;
    try { return await operation(session); }
    finally { session.busy = false; }
  }

  async status(sessionId) {
    return this.#operation(sessionId, async (session) => {
      const result = await this.#transport.status(session);
      if (result?.protocolVersion !== 2 || !Number.isInteger(result.participantCount) ||
          result.participantCount < 1 || result.participantCount > 8 ||
          !Array.isArray(result.participants) || result.participants.length !== result.participantCount) {
        throw new LinkError("INVALID_RELAY_RESPONSE", "The relay returned invalid room metadata.", 502);
      }
      const participants = result.participants.map((member) => {
        const id = typeof member === "string" ? member : member?.participantId;
        if (typeof id !== "string" || !ID.test(id)) throw new LinkError("INVALID_RELAY_RESPONSE", "The relay returned invalid participant metadata.", 502);
        return { participantId: id };
      });
      if (new Set(participants.map((member) => member.participantId)).size !== participants.length ||
          !participants.some((member) => member.participantId === session.identity.participantId) ||
          expiry(result.expiresAt) !== session.expiresAt) {
        throw new LinkError("INVALID_RELAY_RESPONSE", "The relay returned inconsistent room metadata.", 502);
      }
      return { ...publicSession(session), participantCount: result.participantCount, maxParticipants: 8, participants,
        pendingMessages: session.inbox.size, outgoingRequests: session.sends.size };
    });
  }

  async send(sessionId, options) {
    fields(options, ["text", "requestId", "messageType", "inReplyTo"], ["text", "requestId"]);
    if (typeof options.requestId !== "string" || !REQUEST_ID.test(options.requestId)) invalid("requestId must contain 1–80 ASCII letters, digits, hyphens, or underscores.");
    const messageType = options.messageType ?? "message";
    if (!SEND_TYPES.includes(messageType)) invalid("Generic agents may send message, agent_ack, agent_progress, or agent_reply; they cannot claim a human message or send raw receipts.");
    if (typeof options.text === "string" && options.text.startsWith(RECEIPT)) invalid("The process-receipt prefix is reserved for the client transport.");
    if (options.inReplyTo !== undefined && (typeof options.inReplyTo !== "string" || !ID.test(options.inReplyTo))) invalid("inReplyTo must be a message ID.");
    return this.#operation(sessionId, async (session) => {
      if (options.inReplyTo !== undefined && !session.incomingIds.has(options.inReplyTo)) invalid("Replies must refer to an incoming message already authenticated by this session.");
      if (messageType !== "message" && options.inReplyTo === undefined) invalid("Typed agent replies require inReplyTo.");
      let envelope;
      try {
        envelope = encryptMessage(session.invitation, session.identity.participantId, options.text, session.identity,
          { messageType, inReplyTo: options.inReplyTo, displayName: session.displayName });
      } catch { return invalid("Messages must be non-empty text with an encrypted payload of at most 8 KiB."); }
      const fingerprint = createHash("sha256").update(JSON.stringify([options.text, messageType, options.inReplyTo ?? null])).digest("hex");
      let entry = session.sends.get(options.requestId);
      if (entry && entry.fingerprint !== fingerprint) throw new LinkError("REQUEST_ID_CONFLICT", "This requestId was already used for different content.", 409);
      if (!entry) {
        if (session.sends.size >= MAX_SENDS) throw new LinkError("LOCAL_LIMIT", "This session reached its 1024 outgoing-request limit. Start a new session.", 429);
        entry = { envelope, fingerprint, accepted: false, acknowledgedBy: new Set() };
        session.sends.set(options.requestId, entry);
      }
      const duplicate = entry.accepted;
      if (!duplicate) {
        try {
          const response = await this.#transport.send(session, entry.envelope);
          if (response?.accepted !== true) throw new Error();
          entry.accepted = true;
        } catch (error) {
          // Keep the exact encrypted envelope for an explicit retry. Never create
          // another message ID just because a response was lost.
          if (error instanceof LinkError && error.status >= 400 && error.status < 500) throw error;
          throw new LinkError("SEND_UNCONFIRMED", "Delivery acceptance is unconfirmed. No automatic retry was made; an explicit retry must reuse this requestId and identical content.", 502,
            { messageId: entry.envelope.messageId, requestId: options.requestId });
        }
      }
      return { accepted: true, messageId: entry.envelope.messageId, requestId: options.requestId, duplicate,
        acknowledgedBy: [...entry.acknowledgedBy] };
    });
  }

  async receive(sessionId, options = {}) {
    fields(options, ["waitMs"]);
    const waitMs = options.waitMs ?? 0;
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > MAX_WAIT_MS) invalid("waitMs must be an integer from 0 to 15000.");
    return this.#operation(sessionId, async (session) => {
      const response = await this.#transport.receive(session, session.inbox.size ? 0 : waitMs);
      if (!Array.isArray(response?.messages) || response.messages.length > MAX_INBOX) {
        throw new LinkError("INVALID_RELAY_RESPONSE", "The relay returned an invalid encrypted-message batch.", 502);
      }
      const cleanup = new Set();
      const deliveryReceipts = [];
      let rejectedCount = 0;
      let receiptFailures = 0;
      for (const envelope of response.messages) {
        if (session.inbox.has(envelope?.messageId)) continue;
        let payload;
        try {
          if (envelope?.senderId === session.identity.participantId) throw new Error();
          payload = decryptMessagePayload(session.invitation, envelope, session.seen);
        } catch {
          rejectedCount += 1;
          if (typeof envelope?.messageId === "string" && ID.test(envelope.messageId)) cleanup.add(envelope.messageId);
          continue;
        }
        const receipt = payload.text.match(/^\[\[codex-link-receipt:v1\]\]([A-Za-z0-9_-]{22})$/);
        if (receipt || payload.messageType === "receipt") {
          cleanup.add(envelope.messageId);
          if (receipt) {
            for (const entry of session.sends.values()) {
              if (entry.envelope.messageId === receipt[1] && !entry.acknowledgedBy.has(envelope.senderId)) {
                entry.acknowledgedBy.add(envelope.senderId);
                deliveryReceipts.push({ messageId: receipt[1], participantId: envelope.senderId });
              }
            }
          }
          continue;
        }
        // Do not consume a fresh message if the application inbox is full.
        if (session.inbox.size >= MAX_INBOX) {
          session.seen.delete(envelope.messageId);
          continue;
        }
        session.inbox.set(envelope.messageId, {
          messageId: envelope.messageId, participantId: envelope.senderId,
          text: payload.text, messageType: payload.messageType,
          ...(payload.displayName ? { displayName: payload.displayName } : {}),
          ...(payload.inReplyTo ? { inReplyTo: payload.inReplyTo } : {}),
          untrusted: true,
        });
        session.incomingIds.add(envelope.messageId);
        if (session.incomingIds.size > 4096) session.incomingIds.delete(session.incomingIds.values().next().value);
        try {
          const confirmation = encryptMessage(session.invitation, session.identity.participantId,
            `${RECEIPT}${envelope.messageId}`, session.identity, { messageType: "receipt" });
          await this.#transport.send(session, confirmation);
        } catch { receiptFailures += 1; }
      }
      let cleanupPending = false;
      if (cleanup.size) {
        try { await this.#transport.ack(session, [...cleanup]); }
        catch { cleanupPending = true; }
      }
      return { messages: structuredClone([...session.inbox.values()]), deliveryReceipts,
        rejectedCount, receiptFailures, cleanupPending, untrusted: true };
    });
  }

  async acknowledge(sessionId, options) {
    fields(options, ["messageIds"], ["messageIds"]);
    if (!Array.isArray(options.messageIds) || options.messageIds.length < 1 || options.messageIds.length > MAX_INBOX ||
        options.messageIds.some((id) => typeof id !== "string" || !ID.test(id))) invalid("Acknowledge 1–100 authenticated message IDs.");
    return this.#operation(sessionId, async (session) => {
      const ids = [...new Set(options.messageIds)];
      if (ids.some((id) => !session.incomingIds.has(id))) invalid("Only incoming messages authenticated by this session may be acknowledged.");
      const response = await this.#transport.ack(session, ids);
      if (!Number.isInteger(response?.acknowledged) || response.acknowledged < 0 || response.acknowledged > ids.length) {
        throw new LinkError("INVALID_RELAY_RESPONSE", "The relay did not confirm the queue acknowledgement.", 502);
      }
      for (const id of ids) session.inbox.delete(id);
      return { acknowledged: ids.length };
    });
  }

  async disconnect(sessionId) {
    return this.#operation(sessionId, async (session) => {
      // Keep keys if the remote outcome is ambiguous, so the caller may retry.
      const response = await this.#transport.disconnect(session);
      if ((session.isOwner ? response?.closed : response?.left) !== true) {
        throw new LinkError("INVALID_RELAY_RESPONSE", "The relay did not confirm the disconnect. Local session state was retained.", 502);
      }
      this.#sessions.delete(sessionId);
      return { disconnected: true, roomClosed: session.isOwner, roomLeft: !session.isOwner };
    });
  }

  dispose() {
    // Drop references only; JavaScript cannot promise secure memory erasure.
    this.#disposed = true;
    this.#sessions.clear();
  }
}
