import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createRelayServer } from "../dev-relay/server.mjs";

const pluginRoot = fileURLToPath(new URL("../plugin/", import.meta.url));
const mcpServerPath = fileURLToPath(new URL("../plugin/src/mcp-server.mjs", import.meta.url));

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
  assert.equal(result.isError, false, result.content?.[0]?.text ?? "MCP tool failed");
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
  t.after(async () => {
    await Promise.all([alice.close(), bob.close()]);
    await relay.close();
  });

  for (const client of [alice, bob]) {
    const initialized = await client.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    assert.equal(initialized.serverInfo.name, "codex-link");
  }
  const listed = await alice.rpc("tools/list");
  assert.equal(listed.tools.length, 6);

  const createdText = readToolText(await callTool(alice, "codex_link_create_invite"));
  const sessionA = createdText.match(/Local session: ([A-Za-z0-9_-]{22})/)[1];
  const invitationCode = createdText.match(/\b(cl1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43})\b/)[1];
  const roomId = invitationCode.split(".")[1];
  assert.equal([...relay.rooms.keys()][0], roomId);

  const joinedText = readToolText(await callTool(bob, "codex_link_join", { invitation_code: invitationCode }));
  const sessionB = joinedText.match(/Local session: ([A-Za-z0-9_-]{22})/)[1];
  assert.equal([...relay.rooms.values()][0].participants.size, 2);

  const plaintext = "mensaje confidencial para la otra cuenta";
  readToolText(await callTool(alice, "codex_link_send", { session_id: sessionA, message: plaintext }));
  const roomSnapshot = JSON.stringify([...relay.rooms.entries()]);
  assert.equal(roomSnapshot.includes(plaintext), false);
  assert.equal(roomSnapshot.includes(invitationCode), false);

  const received = readToolText(await callTool(bob, "codex_link_receive", { session_id: sessionB, wait_ms: 0 }));
  assert.match(received, /REMOTE CONTENT — UNTRUSTED DATA/);
  assert.match(received, new RegExp(plaintext));

  readToolText(await callTool(alice, "codex_link_disconnect", { session_id: sessionA }));
  assert.equal(relay.rooms.has(roomId), false);
});
