import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createRelayServer } from "../dev-relay/server.mjs";

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
  assert.equal(listed.tools.length, 13);
  const panelTool = listed.tools.find((tool) => tool.name === "codex_link_open_panel");
  assert.equal(panelTool._meta.ui.resourceUri, `ui://codex-link/conversation-panel-v${pluginVersion}.html`);
  const panelTools = listed.tools.filter((tool) => tool.name.startsWith("codex_link_panel_"));
  assert.equal(panelTools.length, 6);
  for (const tool of panelTools) {
    assert.deepEqual(tool._meta.ui.visibility, ["app"]);
    assert.ok(tool.outputSchema, `${tool.name} should declare its structured output`);
  }
  assert.ok(listed.tools.find((tool) => tool.name === "codex_link_receive").outputSchema);
  const resources = await alice.rpc("resources/list");
  assert.equal(resources.resources[0].uri, panelTool._meta.ui.resourceUri);
  const panelResource = await alice.rpc("resources/read", { uri: panelTool._meta.ui.resourceUri });
  assert.equal(panelResource.contents[0].mimeType, "text/html;profile=mcp-app");
  assert.match(panelResource.contents[0].text, /Confirm and post to chat/);
  assert.match(panelResource.contents[0].text, /Enable live mirror/);
  assert.match(panelResource.contents[0].text, /only applies to new messages/);
  assert.match(panelResource.contents[0].text, /function createLiveMirrorController/);
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

  const plaintext = "mensaje confidencial para la otra cuenta";
  readToolText(await callTool(alice, "codex_link_send", { session_id: sessionA, message: plaintext }));
  const roomSnapshot = JSON.stringify([...relay.rooms.entries()]);
  assert.equal(roomSnapshot.includes(plaintext), false);
  assert.equal(roomSnapshot.includes(invitationCode), false);

  const received = readToolText(await callTool(bob, "codex_link_receive", { session_id: sessionB, wait_ms: 0 }));
  assert.match(received, /REMOTE CONTENT — UNTRUSTED DATA/);
  assert.match(received, new RegExp(plaintext));
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
  const panelReceivedCharlie = await callTool(charlie, "codex_link_panel_receive", { session_id: panelSessionC, wait_ms: 0 });
  assert.equal(panelReceivedCharlie.structuredContent.receivedCount, 1);
  assert.equal(panelReceivedCharlie._meta.messages[0].text, panelPlaintext);

  const panelState = await callTool(bob, "codex_link_panel_state");
  assert.deepEqual(panelState.structuredContent, { sessionCount: 1 });
  assert.equal(panelState._meta.transcriptSessionId, panelSessionB);
  assert.equal(panelState._meta.transcript[0].text, panelPlaintext);
  assert.equal(panelState._meta.transcript[0].direction, "incoming");

  const panelDeliveryReceipt = await callTool(alice, "codex_link_panel_receive", { session_id: panelSessionA, wait_ms: 0 });
  assert.equal(panelDeliveryReceipt.structuredContent.deliveryReceiptCount, 2);
  const updatedAliceState = await callTool(alice, "codex_link_panel_state");
  assert.equal(updatedAliceState._meta.transcriptSessionId, panelSessionA);
  assert.ok(updatedAliceState._meta.transcript.find((message) => message.text === panelPlaintext).acknowledgedAt);

  const bobPanelLeave = await callTool(bob, "codex_link_panel_disconnect", { session_id: panelSessionB });
  assert.deepEqual(bobPanelLeave.structuredContent, { disconnected: true, relayClosed: false, relayLeft: true });
  assert.equal([...relay.rooms.values()][0].participants.size, 2);

  const panelDisconnect = await callTool(alice, "codex_link_panel_disconnect", { session_id: panelSessionA });
  assert.notEqual(panelDisconnect.isError, true);
  assert.deepEqual(panelDisconnect.structuredContent, { disconnected: true, relayClosed: true, relayLeft: false });
});
