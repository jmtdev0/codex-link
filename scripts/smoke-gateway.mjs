import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { LinkClient } from "../link/client.mjs";

export const DEFAULT_GATEWAY = "https://codex-link-gateway.sarda0x.chatgpt.site";

export function gatewaySmokeOptions(args) {
  if (args.length !== 1 || args[0] !== "--confirm-live-test") {
    throw new Error("With human authorization, use --confirm-live-test. This creates and closes its own disposable room and gateway session using synthetic data only.");
  }
  return { gatewayUrl: DEFAULT_GATEWAY };
}

function check(condition) { if (!condition) throw new Error("CHECK_FAILED"); }

// Deliberately no credential output, disk state, request logging or chat posting.
export async function smokeGateway({ gatewayUrl = DEFAULT_GATEWAY } = {}) {
  if (gatewayUrl !== DEFAULT_GATEWAY) throw new Error("The live smoke test is restricted to the explicitly approved gateway.");
  const owner = new LinkClient();
  let room, credential, checksPassed = false, revoked = false, memberLeft = false, roomClosed = false;
  let failureCode;
  let failureHttpStatus;
  let phase = "health";
  let lastHttpStatus;
  let lastErrorCode;
  async function api(path, method = "GET", body, authenticated = true) {
    const response = await fetch(`${gatewayUrl}/bridge/v1${path}`, {
      method, redirect: "error", signal: AbortSignal.timeout(45_000),
      headers: { ...(authenticated && credential ? { authorization: `Bearer ${credential}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const value = await response.json();
    lastHttpStatus = response.status;
    const safeCodes = ["INVALID_INPUT", "RATE_LIMIT", "CAPACITY", "RATE_PROTECTION_UNAVAILABLE", "PROVISION_CONFLICT", "SESSION_BUSY", "RELAY_REJECTED", "RELAY_UNAVAILABLE", "RELAY_ROUTING_BLOCKED", "RELAY_REDIRECT_REJECTED", "RELAY_TIMEOUT_UNSUPPORTED", "RELAY_DNS_FAILED", "RELAY_TLS_FAILED", "INVALID_RELAY_RESPONSE", "GATEWAY_UNAVAILABLE", "NOT_CONFIGURED", "UNAUTHORIZED"];
    safeCodes.push("RELAY_CONTEXT_ERROR", "RELAY_CONNECTION_FAILED", "RELAY_EXTERNAL_REDIRECT", "RELAY_SLASH_REDIRECT", "RELAY_SAME_ORIGIN_REDIRECT", "RELAY_SIGNIN_REDIRECT");
    lastErrorCode = safeCodes.includes(value?.error?.code) ? value.error.code : undefined;
    return { status: response.status, value };
  }
  try {
    const health = await fetch(`${gatewayUrl}/health`, { redirect: "error", signal: AbortSignal.timeout(15_000) });
    check(health.ok && (await health.json()).version === "0.9.0");
    phase = "unauthenticated-access";
    check((await api("/status", "GET", undefined, false)).status === 401);
    phase = "create-disposable-room";
    room = await owner.createRoom({ displayName: "HTTPS smoke owner" });
    const setup = { invitationCode: room.invitationCode, displayName: "HTTPS smoke guest", ttlMinutes: 5,
      consentToPlaintextGateway: true, provisioningKey: randomBytes(32).toString("base64url") };
    phase = "provision";
    const provisioned = await api("/sessions", "POST", setup, false);
    check(provisioned.status === 201 && typeof provisioned.value.credential === "string");
    credential = provisioned.value.credential;
    phase = "recover-same-credential";
    const recovered = await api("/sessions", "POST", setup, false);
    check(recovered.status === 201 && recovered.value.credential === credential);
    phase = "status";
    check((await api("/status")).value.participantCount === 2);
    const marker = randomUUID();
    phase = "receive-from-e2e-client";
    const first = await owner.send(room.sessionId, { text: `Synthetic HTTPS test A ${marker}`, requestId: "https-a" });
    const received = await api("/receive", "POST", {});
    check(received.status === 200 && received.value.messages.length === 1 && received.value.messages[0].messageId === first.messageId && received.value.messages[0].text === `Synthetic HTTPS test A ${marker}` && received.value.untrusted === true);
    phase = "application-ack";
    check((await api("/acks", "POST", { messageIds: [first.messageId] })).status === 200);
    const reply = { text: `Synthetic HTTPS test B ${marker}`, requestId: "https-b", messageType: "agent_reply", inReplyTo: first.messageId };
    phase = "reply-to-e2e-client";
    const sent = await api("/messages", "POST", reply);
    check(sent.status === 202 && sent.value.accepted === true);
    const back = await owner.receive(room.sessionId);
    check(back.messages.length === 1 && back.messages[0].text === reply.text && back.messages[0].messageType === "agent_reply");
    check(back.deliveryReceipts.some(r => r.messageId === first.messageId));
    await owner.acknowledge(room.sessionId, { messageIds: [sent.value.messageId] });
    phase = "process-receipt";
    const receipts = await api("/receive", "POST", {});
    check(receipts.value.messages.length === 0 && receipts.value.deliveryReceipts.some(r => r.messageId === sent.value.messageId));
    phase = "deduplicated-retry";
    const duplicate = await api("/messages", "POST", reply);
    check(duplicate.status === 202 && duplicate.value.duplicate === true && duplicate.value.messageId === sent.value.messageId);
    checksPassed = true;
    phase = "cleanup";
  } catch (error) {
    // Only fixed/allowlisted codes; never arbitrary transport diagnostics.
    failureCode = error?.code && /^[A-Z_]{1,40}$/.test(error.code) ? error.code : "HTTPS_SMOKE_FAILED";
    failureCode = lastErrorCode ?? failureCode;
    failureHttpStatus = lastHttpStatus;
  } finally {
    if (credential) {
      try {
        // Cleanup only: repeating revoke/leave reduces access and is explicitly
        // idempotent. Never apply this retry policy to sends or provisioning.
        for (let attempt = 0; attempt < 2; attempt++) {
          const result = await api("/session", "DELETE");
          revoked = result.status === 200 && result.value.revoked === true;
          memberLeft = revoked && result.value.roomLeft === true;
          if (memberLeft) break;
        }
        if (revoked) check((await api("/status")).status === 410);
      } catch { revoked = false; }
    }
    if (room) {
      try { roomClosed = (await owner.disconnect(room.sessionId)).roomClosed === true; } catch {}
    }
    owner.dispose();
    credential = undefined;
    room = undefined;
  }
  return { passed: checksPassed && revoked && memberLeft && roomClosed, checksPassed, gatewayRevoked: revoked,
    memberLeft, roomClosed, instinctConnectionVerified: false, ...(failureCode ? { failureCode, phase, lastHttpStatus: failureHttpStatus } : {}) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await smokeGateway(gatewaySmokeOptions(process.argv.slice(2)));
    process.stdout.write(JSON.stringify(result) + "\n");
    if (!result.passed) process.exitCode = 1;
  } catch {
    process.stderr.write("Human-authorized opt-in required: node scripts/smoke-gateway.mjs --confirm-live-test\n");
    process.exitCode = 1;
  }
}
