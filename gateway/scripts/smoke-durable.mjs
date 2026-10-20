// Explicit synthetic test against the already approved public Site. No values
// from invitations, credentials or room messages are printed or written to disk.
import assert from "node:assert/strict";
import { createLinkClient } from "../worker/link-client.js";

if (process.argv.slice(2).join(" ") !== "--confirm-live-test") throw new Error("Run only with --confirm-live-test after authorizing a synthetic Site test.");
const baseUrl = "https://codex-link-gateway.sarda0x.chatgpt.site";
const owner = createLinkClient({ baseUrl, consentToPlaintextGateway: true });
let room, closed = false;
try {
  room = await owner.create({ name: "Synthetic QA host", ttlMinutes: 5 });
  const firstSend = await owner.send("Synthetic Link durability check", { requestId: "smoke-before-join" });
  const firstPeer = createLinkClient({ baseUrl, consentToPlaintextGateway: true }), joined = await firstPeer.join(room.invitation, { name: "Synthetic QA peer" });
  const initial = await firstPeer.receive({ waitMs: 0 });
  assert.equal(initial.messages.some(m => m.messageId === firstSend.messageId), true);
  const saved = firstPeer.exportSession();
  const pending = await owner.send("Synthetic message queued between client instances", { requestId: "smoke-pending" });
  const freshPeer = createLinkClient(saved); const resumed = await freshPeer.resume();
  assert.equal(resumed.participantId, joined.participantId);
  const recovered = await freshPeer.receive({ waitMs: 0 });
  assert.deepEqual(recovered.messages.map(m => m.messageId), [pending.messageId]);
  const same = await owner.send("Synthetic message queued between client instances", { requestId: "smoke-pending" });
  assert.equal(same.messageId, pending.messageId); assert.equal(same.duplicate, true);
  assert.equal((await owner.outbox("smoke-pending")).recipients[0].state, "received-by-client");
  await freshPeer.markRead(recovered.nextCursor);
  assert.equal((await owner.outbox("smoke-pending")).recipients[0].state, "read-confirmed");
  const wait = freshPeer.receive({ waitMs: 1500 });
  const duringWait = await owner.send("Synthetic parallel send", { requestId: "smoke-wait" });
  assert.equal((await wait).messages.some(m => m.messageId === duringWait.messageId), true);
  assert.equal((await owner.resume()).participantCount, 2);
  console.log(JSON.stringify({ durableAcceptance: true, deliveryBeforeJoin: true, sameIdentityAfterResume: true, pendingRecovery: true, idempotentRetry: true, independentReceiptReadStates: true, sendDuringWait: true, participants: 2 }));
} finally {
  if (room) {
    try { closed = (await owner.close()).closed === true; } catch {}
    console.log(JSON.stringify({ syntheticRoomClosed: closed }));
    if (!closed) { console.error("Synthetic room closure was not confirmed; its fixed five-minute expiry remains in force."); process.exitCode = 1; }
  }
}
