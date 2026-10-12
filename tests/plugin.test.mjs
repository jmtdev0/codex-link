import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createRelayServer } from "../dev-relay/server.mjs";
import { createLiveMirrorController } from "../plugin/src/live-mirror.mjs";

const pluginRoot = fileURLToPath(new URL("../plugin/", import.meta.url));
const mcpServerPath = fileURLToPath(new URL("../plugin/src/mcp-server.mjs", import.meta.url));
const panelPath = fileURLToPath(new URL("../plugin/ui/conversation-panel.html", import.meta.url));
const manifestPath = fileURLToPath(new URL("../plugin/.codex-plugin/plugin.json", import.meta.url));
const pluginVersion = JSON.parse(await readFile(manifestPath, "utf8")).version;

test("manifest, MCP server, and panel advertise the same plugin version", async () => {
  const serverSource = await readFile(mcpServerPath, "utf8");
  const panelSource = await readFile(panelPath, "utf8");
  assert.match(serverSource, new RegExp(`version: ${JSON.stringify(pluginVersion)}`));
  assert.ok(serverSource.includes(`conversation-panel-v${pluginVersion}.html`));
  assert.ok(panelSource.includes(`version: ${JSON.stringify(pluginVersion)}`));
});

function startMcp(baseUrl) {
  const child = spawn(process.execPath, [mcpServerPath], {
    cwd: pluginRoot,
    env: { ...process.env, CODEX_LINK_RELAY_URL: baseUrl },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  let nextId = 1;
  const stderr = [];
  child.stderr.setEncoding("utf8").on("data", (chunk) => stderr.push(chunk));
  lines.on("line", (line) => {
    let response;
    try {
      response = JSON.parse(line);
    } catch {
      return;
    }
    const waiter = pending.get(response.id);
    if (!waiter) return;
    pending.delete(response.id);
    clearTimeout(waiter.timer);
    if (response.error) waiter.reject(new Error(response.error.message));
    else waiter.resolve(response.result);
  });

  function rpc(method, params = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}; stderr=${stderr.join("")}`));
      }, 5_000);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  return {
    rpc,
    async close() {
      lines.close();
      child.stdin.end();
      if (child.exitCode === null) await once(child, "exit");
    },
  };
}

function readToolText(result) {
  assert.notEqual(result.isError, true, result.content?.[0]?.text ?? "MCP tool failed");
  return result.content?.[0]?.text ?? "";
}

async function callTool(client, name, args = {}) {
  return client.rpc("tools/call", { name, arguments: args });
}

test("packaged MCP tools pair two clients and never relay plaintext or invitation secret", async (t) => {
  const relay = createRelayServer({ port: 0 });
  const address = await relay.listen();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const alice = startMcp(baseUrl);
  const bob = startMcp(baseUrl);
  const charlie = startMcp(baseUrl);
  t.after(async () => {
    await Promise.all([alice.close(), bob.close(), charlie.close()]);
    await relay.close();
  });

  for (const client of [alice, bob, charlie]) {
    const initialized = await client.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    assert.equal(initialized.serverInfo.name, "codex-link");
    assert.equal(initialized.serverInfo.version, pluginVersion);
  }
  const listed = await alice.rpc("tools/list");
  assert.equal(listed.tools.length, 16);
  const panelTool = listed.tools.find((tool) => tool.name === "codex_link_open_panel");
  assert.equal(panelTool._meta.ui.resourceUri, `ui://codex-link/conversation-panel-v${pluginVersion}.html`);
  const panelTools = listed.tools.filter((tool) => tool.name.startsWith("codex_link_panel_"));
  assert.equal(panelTools.length, 8);
  for (const tool of panelTools) {
    assert.deepEqual(tool._meta.ui.visibility, ["app"]);
    assert.ok(tool.outputSchema, `${tool.name} should declare its structured output`);
  }
  assert.ok(listed.tools.find((tool) => tool.name === "codex_link_receive").outputSchema);
  assert.equal(listed.tools.find((tool) => tool.name === "codex_link_agent_send")._meta?.ui?.visibility, undefined);
  assert.deepEqual(listed.tools.find((tool) => tool.name === "codex_link_panel_set_display_name")._meta.ui.visibility, ["app"]);
  const resources = await alice.rpc("resources/list");
  assert.equal(resources.resources[0].uri, panelTool._meta.ui.resourceUri);
  const panelResource = await alice.rpc("resources/read", { uri: panelTool._meta.ui.resourceUri });
  assert.equal(panelResource.contents[0].mimeType, "text/html;profile=mcp-app");
  assert.match(panelResource.contents[0].text, /Confirm and post to chat/);
  assert.match(panelResource.contents[0].text, /Enable live mirror/);
  assert.match(panelResource.contents[0].text, /Enable Agent Participation/);
  assert.match(panelResource.contents[0].text, /Your display name in this room/);
  assert.match(panelResource.contents[0].text, /Names are labels, not verified identities/);
  assert.match(panelResource.contents[0].text, /does not sandbox the model's other tools/);
  assert.match(panelResource.contents[0].text, /only applies to new messages/);
  assert.match(panelResource.contents[0].text, /function createLiveMirrorController/);
  assert.match(panelResource.contents[0].text, /function createChatPostStatusTracker/);
  assert.match(panelResource.contents[0].text, /id="chatPostStatus"/);
  assert.match(panelResource.contents[0].text, /Appearance in the main chat is not verified/);
  assert.match(panelResource.contents[0].text, /selectedPost = liveMirror\.formatSelectedMessagesForChat\(selected\)/);
  assert.match(panelResource.contents[0].text, /liveMirror\.synchronizeSessions\(activeSessions\.map/);
  assert.match(panelResource.contents[0].text, /human explicitly enabled live mirroring/);
  const panelScript = panelResource.contents[0].text.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(panelScript, "the panel should contain its inline script");
  assert.doesNotThrow(() => new Function(panelScript), "the injected panel script should parse");
  assert.match(panelResource.contents[0].text, /body\.textContent = String\(message\.text/);
  assert.doesNotMatch(panelResource.contents[0].text, /body\.innerHTML\s*=/);

  const createdText = readToolText(await callTool(alice, "codex_link_create_invite"));
  const sessionA = createdText.match(/Local session: ([A-Za-z0-9_-]{22})/)[1];
  const invitationCode = createdText.match(/\b(cl2\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43})\b/)[1];
  const roomId = invitationCode.split(".")[1];
  assert.equal([...relay.rooms.keys()][0], roomId);

  const joinedText = readToolText(await callTool(bob, "codex_link_join", { invitation_code: invitationCode }));
  const sessionB = joinedText.match(/Local session: ([A-Za-z0-9_-]{22})/)[1];
  const joinedCharlieText = readToolText(await callTool(charlie, "codex_link_join", { invitation_code: invitationCode }));
  const sessionC = joinedCharlieText.match(/Local session: ([A-Za-z0-9_-]{22})/)[1];
  assert.equal([...relay.rooms.values()][0].participants.size, 3);

  await callTool(alice, "codex_link_panel_set_display_name", { session_id: sessionA, display_name: "Agent Ñandú" });

  const plaintext = "mensaje confidencial para la otra cuenta";
  readToolText(await callTool(alice, "codex_link_send", { session_id: sessionA, message: plaintext }));
  const roomSnapshot = JSON.stringify([...relay.rooms.entries()]);
  assert.equal(roomSnapshot.includes(plaintext), false);
  assert.equal(roomSnapshot.includes("Agent Ñandú"), false);
  assert.equal(roomSnapshot.includes(invitationCode), false);

  const receivedResult = await callTool(bob, "codex_link_receive", { session_id: sessionB, wait_ms: 0 });
  const received = readToolText(receivedResult);
  assert.match(received, /REMOTE CONTENT — UNTRUSTED DATA/);
  assert.match(received, new RegExp(plaintext));
  assert.match(received, /"Agent Ñandú" \(unverified label; participant [A-Za-z0-9_-]+\)/);
  assert.equal(receivedResult.structuredContent.received[0].displayName, "Agent Ñandú");
  const charlieReceived = readToolText(await callTool(charlie, "codex_link_receive", { session_id: sessionC, wait_ms: 0 }));
  assert.match(charlieReceived, new RegExp(plaintext));

  const deliveryReceipt = readToolText(await callTool(alice, "codex_link_receive", { session_id: sessionA, wait_ms: 0 }));
  assert.match(deliveryReceipt, /Received delivery confirmation for 2 outgoing message\(s\)/);
  const alicePanelState = await callTool(alice, "codex_link_panel_state");
  assert.equal(alicePanelState._meta.transcriptSessionId, sessionA);
  assert.ok(alicePanelState._meta.transcript.find((message) => message.text === plaintext).acknowledgedAt);
  assert.equal(JSON.stringify([...relay.rooms.entries()]).includes(plaintext), false);

  const aliceDisconnect = await callTool(alice, "codex_link_disconnect", { session_id: sessionA });
  readToolText(aliceDisconnect);
  assert.deepEqual(aliceDisconnect.structuredContent, { disconnected: true, relayClosed: true, relayLeft: false });
  assert.equal(relay.rooms.has(roomId), false);
  const bobStaleDisconnect = await callTool(bob, "codex_link_disconnect", { session_id: sessionB });
  assert.deepEqual(bobStaleDisconnect.structuredContent, { disconnected: true, relayClosed: false, relayLeft: false });
  const charlieStaleDisconnect = await callTool(charlie, "codex_link_disconnect", { session_id: sessionC });
  assert.deepEqual(charlieStaleDisconnect.structuredContent, { disconnected: true, relayClosed: false, relayLeft: false });
  const bobClearedState = await callTool(bob, "codex_link_panel_state");
  assert.deepEqual(bobClearedState.structuredContent, { sessionCount: 0 });

  const panelInvite = await callTool(alice, "codex_link_panel_create_room");
  assert.notEqual(panelInvite.isError, true);
  assert.deepEqual(panelInvite.structuredContent, { created: true });
  const panelCode = panelInvite._meta.invitationCode;
  const panelSessionA = panelInvite._meta.sessionId;
  assert.match(panelCode, /^cl2\./);
  assert.equal(JSON.stringify(panelInvite.content).includes(panelCode), false);

  const panelJoin = await callTool(bob, "codex_link_panel_join_room", { invitation_code: panelCode });
  assert.notEqual(panelJoin.isError, true);
  assert.deepEqual(panelJoin.structuredContent, { joined: true });
  const panelSessionB = panelJoin._meta.sessionId;
  assert.equal(JSON.stringify(panelJoin.content).includes(panelCode), false);
  const panelJoinCharlie = await callTool(charlie, "codex_link_panel_join_room", { invitation_code: panelCode });
  assert.notEqual(panelJoinCharlie.isError, true);
  const panelSessionC = panelJoinCharlie._meta.sessionId;

  const aliceDisplayName = await callTool(alice, "codex_link_panel_set_display_name", {
    session_id: panelSessionA,
    display_name: " Agent Ñandú ",
  });
  assert.deepEqual(aliceDisplayName.structuredContent, { displayName: "Agent Ñandú" });
  const bobDisplayName = await callTool(bob, "codex_link_panel_set_display_name", {
    session_id: panelSessionB,
    display_name: "Agent Beta",
  });
  assert.deepEqual(bobDisplayName.structuredContent, { displayName: "Agent Beta" });
  const invalidDisplayName = await callTool(bob, "codex_link_panel_set_display_name", {
    session_id: panelSessionB,
    display_name: "x".repeat(33),
  });
  assert.equal(invalidDisplayName.isError, true);
  const namedState = await callTool(bob, "codex_link_panel_state");
  assert.equal(namedState._meta.sessions.find((session) => session.sessionId === panelSessionB).displayName, "Agent Beta");

  const panelPlaintext = "<img src=x onerror=alert(1)> hello from panel";
  const panelSent = await callTool(alice, "codex_link_panel_send", { session_id: panelSessionA, message: panelPlaintext });
  assert.notEqual(panelSent.isError, true);
  assert.deepEqual(panelSent.structuredContent, { sent: true });
  assert.equal(JSON.stringify(panelSent).includes(panelPlaintext), false);
  const panelReceived = await callTool(bob, "codex_link_panel_receive", { session_id: panelSessionB, wait_ms: 0 });
  assert.notEqual(panelReceived.isError, true);
  assert.deepEqual(panelReceived.structuredContent, {
    receivedCount: 1,
    deliveryReceiptCount: 0,
    rejectedCount: 0,
    acknowledgementFailures: 0,
  });
  assert.equal(JSON.stringify(panelReceived.content).includes(panelPlaintext), false);
  assert.equal(panelReceived._meta.messages[0].text, panelPlaintext);
  assert.equal(panelReceived._meta.messages[0].displayName, "Agent Ñandú");
  const encryptedNameSnapshot = JSON.stringify([...relay.rooms.entries()]);
  assert.equal(encryptedNameSnapshot.includes("Agent Ñandú"), false);
  assert.equal(encryptedNameSnapshot.includes("Agent Beta"), false);
  const panelReceivedCharlie = await callTool(charlie, "codex_link_panel_receive", { session_id: panelSessionC, wait_ms: 0 });
  assert.equal(panelReceivedCharlie.structuredContent.receivedCount, 1);
  assert.equal(panelReceivedCharlie._meta.messages[0].text, panelPlaintext);

  const panelState = await callTool(bob, "codex_link_panel_state");
  assert.deepEqual(panelState.structuredContent, { sessionCount: 1 });
  assert.equal(panelState._meta.transcriptSessionId, panelSessionB);
  assert.equal(panelState._meta.transcript[0].text, panelPlaintext);
  assert.equal(panelState._meta.transcript[0].displayName, "Agent Ñandú");
  assert.equal(panelState._meta.transcript[0].direction, "incoming");

  const panelDeliveryReceipt = await callTool(alice, "codex_link_panel_receive", { session_id: panelSessionA, wait_ms: 0 });
  assert.equal(panelDeliveryReceipt.structuredContent.deliveryReceiptCount, 2);
  const updatedAliceState = await callTool(alice, "codex_link_panel_state");
  assert.equal(updatedAliceState._meta.transcriptSessionId, panelSessionA);
  assert.ok(updatedAliceState._meta.transcript.find((message) => message.text === panelPlaintext).acknowledgedAt);

  const panelInstanceId = "a".repeat(32);
  const beforeConsent = await callTool(bob, "codex_link_panel_state", { session_id: panelSessionB, panel_instance_id: panelInstanceId });
  assert.equal(beforeConsent._meta.sessions.find((session) => session.sessionId === panelSessionB).agentParticipation, false);
  const optedIn = await callTool(bob, "codex_link_panel_set_agent_participation", {
    session_id: panelSessionB,
    panel_instance_id: panelInstanceId,
    enabled: true,
  });
  assert.deepEqual(optedIn.structuredContent, { enabled: true });
  const afterConsent = await callTool(bob, "codex_link_panel_state", { session_id: panelSessionB, panel_instance_id: panelInstanceId });
  assert.equal(afterConsent._meta.sessions.find((session) => session.sessionId === panelSessionB).agentParticipation, true);
  const ungatedSendDuringParticipation = await callTool(bob, "codex_link_send", {
    session_id: panelSessionB,
    message: "The ungated send path must be unavailable during Agent Participation.",
  });
  assert.equal(ungatedSendDuringParticipation.isError, true);
  const earlierHuman = panelReceived._meta.messages[0];
  const staleReply = await callTool(bob, "codex_link_agent_send", {
    session_id: panelSessionB,
    panel_instance_id: panelInstanceId,
    in_reply_to_message_id: earlierHuman.messageId,
    message_type: "agent_ack",
    message: "This old message must not trigger a reply.",
  });
  assert.equal(staleReply.isError, true);

  const chatPostsA = [];
  const chatPostsB = [];
  const mirrorA = createLiveMirrorController(async (prompt) => chatPostsA.push(prompt));
  const mirrorB = createLiveMirrorController(async (prompt) => chatPostsB.push(prompt));
  const beforeTwoWayMirrorA = await callTool(alice, "codex_link_panel_state", { session_id: panelSessionA });
  mirrorA.enable(panelSessionA, beforeTwoWayMirrorA._meta.transcript);
  mirrorB.enable(panelSessionB, afterConsent._meta.transcript, { mode: "participate", panelInstanceId });

  const newHumanText = "new human message after consent";
  await callTool(alice, "codex_link_panel_send", { session_id: panelSessionA, message: newHumanText });
  const newHumanReceived = await callTool(bob, "codex_link_panel_receive", { session_id: panelSessionB, wait_ms: 0 });
  assert.equal(newHumanReceived._meta.messages.length, 1);
  const newHuman = newHumanReceived._meta.messages[0];
  assert.equal(newHuman.messageType, "human");
  const newHumanStateA = await callTool(alice, "codex_link_panel_state", { session_id: panelSessionA });
  const newHumanStateB = await callTool(bob, "codex_link_panel_state", { session_id: panelSessionB, panel_instance_id: panelInstanceId });
  assert.equal((await mirrorA.mirror(panelSessionA, newHumanStateA._meta.transcript)).postedCount, 1);
  assert.equal((await mirrorB.mirror(panelSessionB, newHumanStateB._meta.transcript)).postedCount, 1);

  const wrongPanelReply = await callTool(bob, "codex_link_agent_send", {
    session_id: panelSessionB,
    panel_instance_id: "b".repeat(32),
    in_reply_to_message_id: newHuman.messageId,
    message_type: "agent_ack",
    message: "Wrong panel must not send.",
  });
  assert.equal(wrongPanelReply.isError, true);
  const ackSent = await callTool(bob, "codex_link_agent_send", {
    session_id: panelSessionB,
    panel_instance_id: panelInstanceId,
    in_reply_to_message_id: newHuman.messageId,
    message_type: "agent_ack",
    message: "Received; I will look into it.",
  });
  readToolText(ackSent);
  const duplicateAck = await callTool(bob, "codex_link_agent_send", {
    session_id: panelSessionB,
    panel_instance_id: panelInstanceId,
    in_reply_to_message_id: newHuman.messageId,
    message_type: "agent_ack",
    message: "A second ACK is rejected.",
  });
  assert.equal(duplicateAck.isError, true);
  for (let progressIndex = 0; progressIndex < 8; progressIndex += 1) {
    const sent = await callTool(bob, "codex_link_agent_send", {
      session_id: panelSessionB,
      panel_instance_id: panelInstanceId,
      in_reply_to_message_id: newHuman.messageId,
      message_type: "agent_progress",
      message: `Progress ${progressIndex + 1}.`,
    });
    readToolText(sent);
  }
  const ninthProgress = await callTool(bob, "codex_link_agent_send", {
    session_id: panelSessionB,
    panel_instance_id: panelInstanceId,
    in_reply_to_message_id: newHuman.messageId,
    message_type: "agent_progress",
    message: "This progress update exceeds the cap.",
  });
  assert.equal(ninthProgress.isError, true);
  const finalReply = await callTool(bob, "codex_link_agent_send", {
    session_id: panelSessionB,
    panel_instance_id: panelInstanceId,
    in_reply_to_message_id: newHuman.messageId,
    message_type: "agent_reply",
    message: "Here is the answer.",
  });
  readToolText(finalReply);
  const duplicateFinal = await callTool(bob, "codex_link_agent_send", {
    session_id: panelSessionB,
    panel_instance_id: panelInstanceId,
    in_reply_to_message_id: newHuman.messageId,
    message_type: "agent_reply",
    message: "A second final answer is rejected.",
  });
  assert.equal(duplicateFinal.isError, true);
  const relayAfterAgentReplies = JSON.stringify([...relay.rooms.entries()]);
  assert.equal(relayAfterAgentReplies.includes(newHumanText), false);
  assert.equal(relayAfterAgentReplies.includes("agent_ack"), false);
  assert.equal(relayAfterAgentReplies.includes("agent_reply"), false);

  const aliceAgentMessages = await callTool(alice, "codex_link_panel_receive", { session_id: panelSessionA, wait_ms: 0 });
  assert.deepEqual(aliceAgentMessages._meta.messages.map((message) => message.messageType), ["agent_ack", ...Array(8).fill("agent_progress"), "agent_reply"]);
  assert.ok(aliceAgentMessages._meta.messages.every((message) => message.displayName === "Agent Beta"));
  assert.ok(aliceAgentMessages._meta.messages.every((message) => message.inReplyTo === newHuman.messageId));
  const bobTranscriptAfterReply = await callTool(bob, "codex_link_panel_state", { session_id: panelSessionB, panel_instance_id: panelInstanceId });
  assert.deepEqual(
    bobTranscriptAfterReply._meta.transcript.filter((message) => message.direction === "outgoing").map((message) => message.messageType),
    ["agent_ack", ...Array(8).fill("agent_progress"), "agent_reply"],
  );
  const aliceTranscriptAfterReply = await callTool(alice, "codex_link_panel_state", { session_id: panelSessionA });
  assert.equal((await mirrorA.mirror(panelSessionA, aliceTranscriptAfterReply._meta.transcript)).postedCount, 1);
  assert.equal((await mirrorB.mirror(panelSessionB, bobTranscriptAfterReply._meta.transcript)).postedCount, 1);
  const mirroredA = chatPostsA.flatMap(prompt => JSON.parse(prompt.split("\n\n").at(-1)));
  const mirroredB = chatPostsB.flatMap(prompt => JSON.parse(prompt.split("\n\n").at(-1)));
  assert.deepEqual(mirroredA.map(message => message.text), [newHumanText, "Here is the answer."]);
  assert.deepEqual(mirroredB.map(message => message.text), [newHumanText, "Here is the answer."]);
  assert.deepEqual(mirroredA.map(message => message.direction), ["outgoing", "incoming"]);
  assert.deepEqual(mirroredB.map(message => message.direction), ["incoming", "outgoing"]);
  assert.deepEqual(mirroredA.map(message => message.message_id), mirroredB.map(message => message.message_id));
  assert.deepEqual(mirroredA.map(message => message.display_name), ["Agent Ñandú", "Agent Beta"]);
  assert.deepEqual(mirroredB.map(message => message.display_name), ["Agent Ñandú", "Agent Beta"]);
  assert.equal(mirroredA[1].in_reply_to_message_id, newHuman.messageId);
  assert.equal(mirroredB[1].in_reply_to_message_id, newHuman.messageId);
  assert.equal((await mirrorA.mirror(panelSessionA, aliceTranscriptAfterReply._meta.transcript)).postedCount, 0);
  assert.equal((await mirrorB.mirror(panelSessionB, bobTranscriptAfterReply._meta.transcript)).postedCount, 0);

  await callTool(bob, "codex_link_panel_send", { session_id: panelSessionB, message: "A local human message is context only for this agent." });
  const localHumanStateB = await callTool(bob, "codex_link_panel_state", { session_id: panelSessionB, panel_instance_id: panelInstanceId });
  const localHumanB = localHumanStateB._meta.transcript.at(-1);
  assert.equal(localHumanB.direction, "outgoing");
  assert.equal(localHumanB.messageType, "human");
  assert.equal((await mirrorB.mirror(panelSessionB, localHumanStateB._meta.transcript)).postedCount, 1);
  const selfReply = await callTool(bob, "codex_link_agent_send", {
    session_id: panelSessionB,
    panel_instance_id: panelInstanceId,
    in_reply_to_message_id: localHumanB.messageId,
    message_type: "agent_ack",
    message: "This outgoing target must not authorize a reply.",
  });
  assert.equal(selfReply.isError, true);
  const optedOut = await callTool(bob, "codex_link_panel_set_agent_participation", {
    session_id: panelSessionB,
    panel_instance_id: panelInstanceId,
    enabled: false,
  });
  assert.deepEqual(optedOut.structuredContent, { enabled: false });
  const blockedAfterOptOut = await callTool(bob, "codex_link_agent_send", {
    session_id: panelSessionB,
    panel_instance_id: panelInstanceId,
    in_reply_to_message_id: newHuman.messageId,
    message_type: "agent_ack",
    message: "Participation is off now.",
  });
  assert.equal(blockedAfterOptOut.isError, true);
  await callTool(bob, "codex_link_panel_set_agent_participation", {
    session_id: panelSessionB,
    panel_instance_id: panelInstanceId,
    enabled: true,
  });
  const reopenedPanelState = await callTool(bob, "codex_link_panel_state", {
    session_id: panelSessionB,
    panel_instance_id: "c".repeat(32),
  });
  assert.equal(reopenedPanelState._meta.sessions.find((session) => session.sessionId === panelSessionB).agentParticipation, false);

  const bobPanelLeave = await callTool(bob, "codex_link_panel_disconnect", { session_id: panelSessionB });
  assert.deepEqual(bobPanelLeave.structuredContent, { disconnected: true, relayClosed: false, relayLeft: true });
  assert.equal([...relay.rooms.values()][0].participants.size, 2);

  const panelDisconnect = await callTool(alice, "codex_link_panel_disconnect", { session_id: panelSessionA });
  assert.notEqual(panelDisconnect.isError, true);
  assert.deepEqual(panelDisconnect.structuredContent, { disconnected: true, relayClosed: true, relayLeft: false });
});
