import { randomBytes, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { VERSION } from "../gateway/worker/index.js";

export const DEFAULT_SITE = "https://codex-link-gateway.sarda0x.chatgpt.site";
export function siteSmokeOptions(args) {
  if (args.length !== 1 || args[0] !== "--confirm-live-test") throw new Error("Explicit human-authorized disposable live test required.");
  return { siteUrl: DEFAULT_SITE };
}
const check = value => { if (!value) throw new Error("CHECK_FAILED"); };

// Only the caller's own synthetic room. No code, credential, header or text output.
export async function smokeLinkSite({ siteUrl = DEFAULT_SITE } = {}) {
  if (siteUrl !== DEFAULT_SITE) throw new Error("Only the approved Link Site is supported.");
  let owner, guest, passed = false, guestRevoked = false, memberLeft = false, roomClosed = false, ownerRevoked = false;
  let phase = "health", failureCode, httpStatus;
  const safeCodes = new Set(["RATE_LIMIT", "CAPACITY", "SESSION_BUSY", "RELAY_REJECTED", "RELAY_UNAVAILABLE", "INVALID_RELAY_RESPONSE", "GATEWAY_UNAVAILABLE", "OWNER_REQUIRED", "UNAUTHORIZED", "PROVISION_CONFLICT"]);
  async function api(path, method = "GET", body, credential) {
    const response = await fetch(siteUrl + "/bridge/v1" + path, {
      method, redirect: "error", signal: AbortSignal.timeout(45_000),
      headers: { accept: "application/json", ...(body ? { "content-type": "application/json" } : {}), ...(credential ? { authorization: "Bearer " + credential } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    httpStatus = response.status;
    const value = await response.json();
    if (value?.error && safeCodes.has(value.error.code)) failureCode = value.error.code;
    return { status: response.status, value };
  }
  try {
    const health = await fetch(siteUrl + "/health", { redirect: "error", signal: AbortSignal.timeout(15_000) });
    check(health.ok && (await health.json()).version === VERSION);
    phase = "create-http-owner";
    const body = { displayName: "Link synthetic host", consentToPlaintextGateway: true, provisioningKey: randomBytes(32).toString("base64url") };
    const created = await api("/rooms", "POST", body);
    check(created.status === 201);
    owner = created.value;
    check(owner.role === "owner" && owner.invitationCode && owner.credential && owner.expiresAt === owner.roomExpiresAt);
    phase = "recover-identical-owner";
    const recovered = await api("/rooms", "POST", body);
    check(recovered.status === 201 && recovered.value.credential === owner.credential && recovered.value.invitationCode === owner.invitationCode);
    phase = "join-http-peer";
    const joined = await api("/sessions", "POST", { invitationCode: owner.invitationCode, displayName: "Link synthetic peer", ttlMinutes: 5,
      consentToPlaintextGateway: true, provisioningKey: randomBytes(32).toString("base64url") });
    check(joined.status === 201);
    guest = joined.value;
    check(guest.role === "member" && guest.credential !== owner.credential);
    check((await api("/status", "GET", undefined, owner.credential)).value.participantCount === 2);
    phase = "owner-invitation";
    check((await api("/invitation", "GET", undefined, owner.credential)).value.invitationCode === owner.invitationCode);
    phase = "guest-cannot-close";
    check((await api("/room", "DELETE", undefined, guest.credential)).status === 403);
    failureCode = undefined;
    const marker = randomUUID();
    const firstBody = { text: "Synthetic Link HTTPS round trip A " + marker, requestId: "link-site-a" };
    phase = "owner-to-peer";
    const sent = await api("/messages", "POST", firstBody, owner.credential);
    check(sent.status === 202 && sent.value.accepted === true);
    const received = await api("/receive", "POST", {}, guest.credential);
    check(received.status === 200 && received.value.messages.length === 1 && received.value.messages[0].text === firstBody.text);
    check((await api("/acks", "POST", { messageIds: [sent.value.messageId] }, guest.credential)).status === 200);
    const reply = { text: "Synthetic Link HTTPS round trip B " + marker, requestId: "link-site-b", messageType: "agent_reply", inReplyTo: sent.value.messageId };
    phase = "peer-to-owner";
    const back = await api("/messages", "POST", reply, guest.credential);
    check(back.status === 202);
    const onOwner = await api("/receive", "POST", {}, owner.credential);
    check(onOwner.value.messages.length === 1 && onOwner.value.messages[0].text === reply.text && onOwner.value.messages[0].messageType === "agent_reply");
    check((await api("/acks", "POST", { messageIds: [back.value.messageId] }, owner.credential)).status === 200);
    phase = "deduplicated-reply";
    const duplicate = await api("/messages", "POST", reply, guest.credential);
    check(duplicate.status === 202 && duplicate.value.duplicate === true && duplicate.value.messageId === back.value.messageId);
    phase = "process-receipt";
    const receipt = await api("/receive", "POST", {}, guest.credential);
    check(receipt.value.messages.length === 0 && receipt.value.deliveryReceipts.some(r => r.messageId === back.value.messageId));
    passed = true;
    failureCode = undefined;
  } catch { failureCode ??= "LINK_SITE_SMOKE_FAILED"; }
  finally {
    if (guest?.credential) {
      try {
        for (let i = 0; i < 2 && !memberLeft; i++) {
          const result = await api("/session", "DELETE", undefined, guest.credential);
          guestRevoked = result.status === 200 && result.value.revoked === true;
          memberLeft = guestRevoked && result.value.roomLeft === true;
        }
      } catch {}
    }
    if (owner?.credential) {
      try {
        for (let i = 0; i < 2 && !roomClosed; i++) {
          const result = await api("/room", "DELETE", undefined, owner.credential);
          ownerRevoked = result.status === 200 && result.value.revoked === true;
          roomClosed = ownerRevoked && result.value.roomClosed === true;
        }
        if (roomClosed) check((await api("/status", "GET", undefined, owner.credential)).status === 410);
      } catch { roomClosed = false; }
    }
    owner = undefined; guest = undefined;
  }
  return { passed: passed && guestRevoked && memberLeft && ownerRevoked && roomClosed, transportPassed: passed,
    guestRevoked, memberLeft, ownerRevoked, roomClosed, nativeAgentConnectionVerified: false,
    ...(failureCode ? { failureCode, phase, httpStatus } : {}) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await smokeLinkSite(siteSmokeOptions(process.argv.slice(2)));
    process.stdout.write(JSON.stringify(result) + "\n");
    if (!result.passed) process.exitCode = 1;
  } catch { process.stderr.write("Use node scripts/smoke-link-site.mjs --confirm-live-test only with human authorization.\n"); process.exitCode = 1; }
}
