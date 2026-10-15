import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { LinkClient, LinkError } from "../link/client.mjs";
import { DEFAULT_RELAY_URL, normalizeRelayUrl } from "../link/transport.mjs";
import { publicError } from "../link/errors.mjs";

export function smokeOptions(args) {
  let confirmed = false;
  let relayUrl = DEFAULT_RELAY_URL;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--confirm-live-test") confirmed = true;
    else if (args[index] === "--relay" && index + 1 < args.length) relayUrl = args[++index];
    else throw new LinkError("INVALID_ARGUMENTS", "Use --confirm-live-test and optionally --relay APPROVED_HTTPS_URL.");
  }
  if (!confirmed) throw new LinkError("LIVE_TEST_CONFIRMATION_REQUIRED", "This writes a temporary room and synthetic ciphertext to a relay. With your human's approval, pass --confirm-live-test.");
  return { relayUrl: normalizeRelayUrl(relayUrl) };
}

function check(condition) {
  if (!condition) throw new LinkError("SMOKE_CHECK_FAILED", "A live Link transport check did not pass.", 502);
}

export async function smokeLink({ relayUrl }) {
  const a = new LinkClient({ relayUrl });
  const b = new LinkClient({ relayUrl });
  const originalFetch = globalThis.fetch;
  const requests = [];
  const runId = randomUUID();
  const outbound = `Link synthetic transport check A ${runId}`;
  const inbound = `Link synthetic transport check B ${runId}`;
  let owner;
  let member;
  let error;
  let passed = false;
  let closed = false;
  let left = false;
  // This command runs in its own process. Retain wire data in RAM only and
  // never include it, cryptographic proofs, or credentials in diagnostics.
  globalThis.fetch = (url, init) => {
    requests.push(JSON.stringify({ url: String(url), headers: init.headers, body: init.body }));
    return originalFetch(url, init);
  };
  try {
    owner = await a.createRoom({ displayName: "Link smoke A" });
    member = await b.joinRoom({ invitationCode: owner.invitationCode, displayName: "Link smoke B" });
    check((await a.status(owner.sessionId)).participantCount === 2);
    const sent = await a.send(owner.sessionId, { text: outbound, requestId: "smoke-a" });
    const first = await b.receive(member.sessionId, { waitMs: 1000 });
    check(first.messages.length === 1 && first.messages[0].messageId === sent.messageId && first.messages[0].text === outbound);
    await b.acknowledge(member.sessionId, { messageIds: [sent.messageId] });
    const replied = await b.send(member.sessionId, { text: inbound, requestId: "smoke-b", inReplyTo: sent.messageId });
    const second = await a.receive(owner.sessionId, { waitMs: 1000 });
    check(second.messages.length === 1 && second.messages[0].messageId === replied.messageId && second.messages[0].text === inbound);
    check(second.deliveryReceipts.some((receipt) => receipt.messageId === sent.messageId));
    await a.acknowledge(owner.sessionId, { messageIds: [replied.messageId] });
    const receipts = await b.receive(member.sessionId, { waitMs: 1000 });
    check(receipts.messages.length === 0 && receipts.deliveryReceipts.some((receipt) => receipt.messageId === replied.messageId));
    const wire = requests.join("\n");
    for (const value of [owner.invitationCode, owner.invitationCode.split(".")[2], outbound, inbound, "Link smoke A", "Link smoke B"]) {
      check(!wire.includes(value));
    }
    passed = true;
  } catch (failure) { error = publicError(failure); }
  finally {
    if (member) {
      try { left = (await b.disconnect(member.sessionId)).roomLeft === true; }
      catch { /* Owner closure below is still attempted. */ }
    }
    if (owner) {
      try { closed = (await a.disconnect(owner.sessionId)).roomClosed === true; }
      catch { /* Report incomplete cleanup, never a credential or exception. */ }
    }
    a.dispose();
    b.dispose();
    globalThis.fetch = originalFetch;
    requests.length = 0;
  }
  return { passed: passed && left && closed, checksPassed: passed, memberLeft: left, roomClosed: closed,
    hostedAssistantVerified: false, ...(error ? { error } : {}) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await smokeLink(smokeOptions(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.passed) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: publicError(error) })}\n`);
    process.exitCode = 1;
  }
}
