// Explicit opt-in only. Creates one synthetic room and closes that exact room.
// Never logs room invitations, participant credentials or transcript content.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createLinkClient } from "../../gateway/worker/link-client.js";

if (!process.argv.includes("--approve-synthetic-room")) throw new Error("An explicit synthetic live-room opt-in is required");
const origin = "https://agents-link.netlify.app";
const owner = createLinkClient({ baseUrl: origin, consentToPlaintextGateway: true });
const summary = { origin, checks: [] };
let created = false;
let failure;

function pythonPeer(input) {
  return new Promise((resolve, reject) => {
    const python = process.env.LINK_SMOKE_PYTHON ?? (process.platform === "win32" ? "python" : "python3");
    const child = spawn(python, [fileURLToPath(new URL("./live-peer.py", import.meta.url))], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let output = "", diagnostic = "";
    child.stdout.on("data", data => { output += data; });
    child.stderr.on("data", data => { diagnostic += data; });
    child.on("error", () => reject(new Error("Synthetic Python process could not start")));
    child.on("exit", code => {
      if (code !== 0) {
        let safe;
        try { safe = JSON.parse(diagnostic); } catch { safe = {}; }
        reject(new Error("Synthetic Python peer failed" + (Number.isInteger(safe.status) ? " (HTTP " + safe.status + ")" : "")));
        return;
      }
      try { resolve(JSON.parse(output)); } catch { reject(new Error("Synthetic Python peer returned invalid JSON")); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

try {
  const infoResponse = await fetch(origin + "/link/v1/info");
  assert.equal(infoResponse.status, 200);
  const info = await infoResponse.json();
  assert.equal(info.storage, "postgres"); assert.equal(info.maxMessages, 2000); assert.equal(info.maxTtlMinutes, 20160);
  summary.checks.push("public-info-and-limits");
  const session = await owner.create({ name: "Synthetic Node owner", ttlMinutes: 20160 });
  created = true;
  assert.ok(Date.parse(session.expiresAt) - Date.now() > 20159 * 60000);
  summary.checks.push("create-fourteen-day-room");
  const greeting = "Synthetic Node greeting: independent Link backend test.";
  const sent = await owner.send(greeting, { requestId: "live-node-greeting" });
  const peer = await pythonPeer({ origin, invitation: session.invitation, expectedText: greeting });
  assert.equal(peer.roomId, session.roomId);
  summary.pythonVersion = peer.pythonVersion;
  summary.checks.push("default-python-urllib-info-join-receive-confirm-send");
  const received = await owner.receive({ waitMs: 0 });
  assert.ok(received.messages.some(message => message.messageId === peer.messageId));
  const outbox = await owner.outbox("live-node-greeting");
  assert.equal(outbox.recipients[0].state, "read-confirmed");
  const duplicate = await owner.send(greeting, { requestId: "live-node-greeting" });
  assert.equal(duplicate.messageId, sent.messageId);
  summary.checks.push("bidirectional-message-receipt-and-idempotency");
  const resumedPeer = createLinkClient({ baseUrl: origin, credential: peer.credential });
  assert.equal((await resumedPeer.resume()).participantId, peer.participantId);
  const conversation = await resumedPeer.conversation();
  assert.equal(conversation.messages.length, 2);
  summary.checks.push("independent-client-resume-and-persistent-history");
  const concurrent = await Promise.all([1, 2, 3].map(i => owner.send("Synthetic concurrent message " + i, { requestId: "live-concurrent-" + i })));
  assert.equal(new Set(concurrent.map(message => message.messageId)).size, 3);
  assert.equal(new Set(concurrent.map(message => message.sequence)).size, 3);
  summary.checks.push("concurrent-message-allocation");
  const denied = await fetch(origin + "/link/v1/conversation", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(denied.status, 401);
  summary.checks.push("unauthenticated-access-denied");
} catch (error) {
  failure = error;
  summary.failed = { name: error.name, ...(error.code ? { code: error.code } : {}), ...(error.status ? { status: error.status } : {}) };
} finally {
  if (created) {
    try { await owner.close(); summary.syntheticRoomClosed = true; }
    catch { summary.syntheticRoomClosed = false; }
  }
}
console.log(JSON.stringify(summary));
if (failure) process.exitCode = 1;
