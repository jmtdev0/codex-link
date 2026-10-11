import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createSitesRelay } from "../site/worker/index.js";
import { createD1TestDatabase, sqliteAvailable } from "./support/d1-test-db.mjs";

const RATE_LIMIT_KEY = "test-only-codex-link-site-rate-limit-key";
const pluginRoot = fileURLToPath(new URL("../plugin/", import.meta.url));
const mcpServerPath = fileURLToPath(new URL("../plugin/src/mcp-server.mjs", import.meta.url));

function startMcp(baseUrl) {
  const child = spawn(process.execPath, [mcpServerPath], {
    cwd: pluginRoot,
    env: {
      ...process.env,
      CODEX_LINK_RELAY_URL: baseUrl,
      CODEX_LINK_ACCESS_TOKEN: "obsolete-user-token-is-ignored",
      CODEX_LINK_SITES_BYPASS_TOKEN: "obsolete-sites-token-is-ignored",
      CODEX_LINK_SITES_ALLOWED_ORIGIN: "",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  const stderr = [];
  let nextId = 1;
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

function callTool(client, name, args = {}) {
  return client.rpc("tools/call", { name, arguments: args });
}

test("packaged MCP clients exchange encrypted messages through the Site Worker and D1", { skip: !sqliteAvailable }, async (t) => {
  const db = await createD1TestDatabase();
  const worker = createSitesRelay({ cleanupIntervalMs: 0, waitPollMs: 5 });
  const server = createServer(async (incoming, outgoing) => {
    try {
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const headers = new Headers();
      for (const name of ["accept", "authorization", "content-type"]) {
        const value = incoming.headers[name];
        if (typeof value === "string") headers.set(name, value);
      }
      headers.set("cf-connecting-ip", "127.0.0.1");
      const request = new Request(`http://127.0.0.1${incoming.url}`, {
        method: incoming.method,
        headers,
        body: body.length ? body : undefined,
      });
      const response = await worker.fetch(request, {
        CODEX_LINK_RATE_LIMIT_KEY: RATE_LIMIT_KEY,
        DB: db,
      });
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      outgoing.writeHead(500);
      outgoing.end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const alice = startMcp(baseUrl);
  const bob = startMcp(baseUrl);

  t.after(async () => {
    await Promise.all([alice.close(), bob.close()]);
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    db.close();
  });

  for (const client of [alice, bob]) {
    const initialized = await client.rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "site-e2e-test", version: "0" },
    });
    assert.equal(initialized.serverInfo.name, "codex-link");
  }

  const createdText = readToolText(await callTool(alice, "codex_link_create_invite"));
  const sessionA = createdText.match(/Local session: ([A-Za-z0-9_-]{22})/)[1];
  const invitationCode = createdText.match(/\b(cl2\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43})\b/)[1];
  const invitationSecret = invitationCode.split(".")[2];
  const joinedText = readToolText(await callTool(bob, "codex_link_join", { invitation_code: invitationCode }));
  const sessionB = joinedText.match(/Local session: ([A-Za-z0-9_-]{22})/)[1];

  const plaintext = "integración real del plugin con Worker y D1";
  readToolText(await callTool(alice, "codex_link_send", { session_id: sessionA, message: plaintext }));
  const persisted = JSON.stringify(db.sqlite.prepare("SELECT envelope_json FROM codex_link_messages").all());
  assert.equal(persisted.includes(plaintext), false);
  assert.equal(persisted.includes(invitationSecret), false);

  const received = readToolText(await callTool(bob, "codex_link_receive", { session_id: sessionB, wait_ms: 0 }));
  assert.match(received, /REMOTE CONTENT — UNTRUSTED DATA/);
  assert.match(received, new RegExp(plaintext));
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM codex_link_messages").get().count, 1);
  const queuedReceipt = JSON.stringify(db.sqlite.prepare("SELECT envelope_json FROM codex_link_messages").all());
  assert.equal(queuedReceipt.includes("[[codex-link-receipt:v1]]"), false);

  const firstReceipt = await callTool(alice, "codex_link_receive", { session_id: sessionA, wait_ms: 0 });
  assert.equal(firstReceipt.structuredContent.deliveryReceiptCount, 1);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM codex_link_messages").get().count, 0);

  const reply = "respuesta de vuelta por la otra instancia MCP";
  readToolText(await callTool(bob, "codex_link_send", { session_id: sessionB, message: reply }));
  const response = readToolText(await callTool(alice, "codex_link_receive", { session_id: sessionA, wait_ms: 0 }));
  assert.match(response, new RegExp(reply));
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM codex_link_messages").get().count, 1);
  const replyReceipt = await callTool(bob, "codex_link_receive", { session_id: sessionB, wait_ms: 0 });
  assert.equal(replyReceipt.structuredContent.deliveryReceiptCount, 1);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM codex_link_messages").get().count, 0);

  readToolText(await callTool(alice, "codex_link_disconnect", { session_id: sessionA }));
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS count FROM codex_link_rooms").get().count, 0);
});
