import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";

export const PROTOCOL_VERSION = 1;
export const MAX_MESSAGE_BYTES = 8 * 1024;

const ROOM_ID_BYTES = 16;
const SECRET_BYTES = 32;
const PARTICIPANT_ID_BYTES = 16;
const MESSAGE_ID_BYTES = 16;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

function encode(bytes) {
  return Buffer.from(bytes).toString("base64url");
}

function decode(value, expectedBytes, label) {
  if (typeof value !== "string" || !BASE64URL.test(value)) {
    throw new Error(`Invalid ${label}.`);
  }
  const bytes = Buffer.from(value, "base64url");
  if ((expectedBytes !== undefined && bytes.length !== expectedBytes) || encode(bytes) !== value) {
    throw new Error(`Invalid ${label}.`);
  }
  return bytes;
}

export function randomId() {
  return encode(randomBytes(PARTICIPANT_ID_BYTES));
}

export function createInvitation() {
  const roomId = encode(randomBytes(ROOM_ID_BYTES));
  const secret = encode(randomBytes(SECRET_BYTES));
  return { roomId, secret, code: `cl1.${roomId}.${secret}` };
}

export function parseInvitation(code) {
  if (typeof code !== "string") throw new Error("Invalid invitation code.");
  const parts = code.trim().split(".");
  if (parts.length !== 3 || parts[0] !== "cl1") {
    throw new Error("Invalid invitation code.");
  }
  decode(parts[1], ROOM_ID_BYTES, "room ID");
  decode(parts[2], SECRET_BYTES, "invitation secret");
  return { roomId: parts[1], secret: parts[2], code: parts.join(".") };
}

export function deriveRoomCapability(invitation) {
  const secret = decode(invitation.secret, SECRET_BYTES, "invitation secret");
  const roomId = decode(invitation.roomId, ROOM_ID_BYTES, "room ID");
  const info = Buffer.from("codex-link/v1/relay-capability", "utf8");
  return encode(hkdfSync("sha256", secret, roomId, info, SECRET_BYTES));
}

function messageKey(invitation, senderId) {
  const secret = decode(invitation.secret, SECRET_BYTES, "invitation secret");
  decode(invitation.roomId, ROOM_ID_BYTES, "room ID");
  decode(senderId, PARTICIPANT_ID_BYTES, "participant ID");
  const info = Buffer.from(`codex-link/v1/message/${senderId}`, "utf8");
  return Buffer.from(hkdfSync("sha256", secret, Buffer.from(invitation.roomId), info, 32));
}

function envelopeAad(envelope) {
  return Buffer.from(
    `codex-link/v${PROTOCOL_VERSION}|${envelope.roomId}|${envelope.senderId}|${envelope.messageId}`,
    "utf8",
  );
}

function validateEnvelope(envelope, expectedRoomId) {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new Error("Invalid encrypted message.");
  }
  const allowed = new Set(["v", "roomId", "senderId", "messageId", "nonce", "ciphertext", "tag"]);
  if (Object.keys(envelope).some((key) => !allowed.has(key)) || Object.keys(envelope).length !== allowed.size) {
    throw new Error("Invalid encrypted message.");
  }
  if (envelope.v !== PROTOCOL_VERSION || envelope.roomId !== expectedRoomId) {
    throw new Error("Encrypted message belongs to another room or protocol version.");
  }
  decode(envelope.roomId, ROOM_ID_BYTES, "room ID");
  decode(envelope.senderId, PARTICIPANT_ID_BYTES, "participant ID");
  decode(envelope.messageId, MESSAGE_ID_BYTES, "message ID");
  decode(envelope.nonce, NONCE_BYTES, "nonce");
  decode(envelope.tag, TAG_BYTES, "authentication tag");
  const ciphertext = decode(envelope.ciphertext, undefined, "ciphertext");
  if (ciphertext.length < 1 || ciphertext.length > MAX_MESSAGE_BYTES + 1024) {
    throw new Error("Encrypted message is too large.");
  }
  return { ciphertext };
}

export function encryptMessage(invitation, senderId, text) {
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new Error("Message must be non-empty text.");
  }
  const plaintext = Buffer.from(JSON.stringify({ type: "text", text }), "utf8");
  if (plaintext.length > MAX_MESSAGE_BYTES) throw new Error("Message exceeds the 8 KiB limit.");

  const envelope = {
    v: PROTOCOL_VERSION,
    roomId: invitation.roomId,
    senderId,
    messageId: encode(randomBytes(MESSAGE_ID_BYTES)),
    nonce: encode(randomBytes(NONCE_BYTES)),
  };
  const cipher = createCipheriv("aes-256-gcm", messageKey(invitation, senderId), Buffer.from(envelope.nonce, "base64url"));
  cipher.setAAD(envelopeAad(envelope));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  envelope.ciphertext = encode(ciphertext);
  envelope.tag = encode(cipher.getAuthTag());
  return envelope;
}

export function decryptMessage(invitation, envelope, seenMessageIds = new Set()) {
  const { ciphertext } = validateEnvelope(envelope, invitation.roomId);
  if (seenMessageIds.has(envelope.messageId)) throw new Error("Replay rejected.");

  let plaintext;
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      messageKey(invitation, envelope.senderId),
      Buffer.from(envelope.nonce, "base64url"),
    );
    decipher.setAAD(envelopeAad(envelope));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error("Message authentication failed; invitation or ciphertext is invalid.");
  }

  let decoded;
  try {
    decoded = JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw new Error("Authenticated message payload is malformed.");
  }
  if (decoded?.type !== "text" || typeof decoded.text !== "string" || decoded.text.trim().length === 0) {
    throw new Error("Authenticated message payload has an unsupported format.");
  }
  if (plaintext.length > MAX_MESSAGE_BYTES) throw new Error("Decrypted message is too large.");

  seenMessageIds.add(envelope.messageId);
  if (seenMessageIds.size > 4096) seenMessageIds.delete(seenMessageIds.values().next().value);
  return decoded.text;
}
