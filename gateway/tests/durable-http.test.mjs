import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createGateway } from "../worker/index.js";
import { TestD1 } from "./support/d1.mjs";

test("real HTTP and two successive fresh processes resume without missed or duplicate messages", async t => {
  let clock = Date.now(); const DB = new TestD1(), env = { DB, LINK_GATEWAY_MASTER_KEY: randomBytes(32).toString("base64url") };
  let gateway = createGateway({ now: () => clock, maxCreates: 100, maxRequests: 10000, maxIngress: 10000 });
  let authority;
  const server = http.createServer(async (incoming, outgoing) => {
    try {
      const chunks = []; for await (const chunk of incoming) chunks.push(chunk);
      const cancellation = new AbortController(); outgoing.once("close", () => cancellation.abort());
      const request = new Request("https://" + authority + incoming.url, { method: incoming.method,
        headers: { ...incoming.headers, "cf-connecting-ip": "real-http-test" }, signal: cancellation.signal,
        ...(["GET", "HEAD"].includes(incoming.method) ? {} : { body: Buffer.concat(chunks) }) });
      const response = await gateway.fetch(request, env), content = await response.text();
      outgoing.writeHead(response.status, { "content-type": response.headers.get("content-type") });
      if (response.headers.get("content-type")?.startsWith("application/json")) {
        const data = JSON.parse(content); if (data.apiBase === "https://" + authority + "/link/v1") data.apiBase = "http://" + authority + "/link/v1";
        outgoing.end(JSON.stringify(data));
      } else outgoing.end(content);
    } catch { outgoing.writeHead(500).end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); authority = "127.0.0.1:" + server.address().port;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); DB.close(); });
  const baseUrl = "http://" + authority;
  // Exercise the actual downloadable module, not a second SDK implementation.
  const moduleResponse = await fetch(baseUrl + "/link-client.mjs"); assert.equal(moduleResponse.status, 200);
  const { createLinkClient } = await import("data:text/javascript;base64," + Buffer.from(await moduleResponse.text()).toString("base64"));
  const owner = createLinkClient({ baseUrl, consentToPlaintextGateway: true });
  const room = await owner.create({ name: "HTTP owner" }); await owner.send("Before peer process one", { requestId: "http-first" });
  const peer = createLinkClient({ baseUrl, consentToPlaintextGateway: true }), joined = await peer.join(room.invitation, { name: "Process peer" });
  const saved = peer.exportSession();
  function once(input) { return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./support/client-once.mjs", import.meta.url))], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let output = "", error = ""; child.stdout.on("data", value => { output += value; }); child.stderr.on("data", value => { error += value; });
    child.once("error", reject); child.once("close", code => { if (code !== 0) reject(new Error("Independent test process failed: " + error)); else { try { resolve(JSON.parse(output)); } catch (e) { reject(e); } } });
    child.stdin.end(JSON.stringify(input));
  }); }
  const first = await once({ session: saved, reply: "From process one", requestId: "process-one" });
  assert.equal(first.participantId, joined.participantId); assert.equal(first.messages[0].text, "Before peer process one");
  assert.equal((await owner.receive({ waitMs: 0 })).messages[0].text, "From process one");
  clock += 8 * 60000; gateway = createGateway({ now: () => clock, maxCreates: 100, maxRequests: 10000, maxIngress: 10000 });
  await owner.send("Queued while the peer process was stopped", { requestId: "http-offline" });
  const second = await once({ session: saved, reply: "From process two", requestId: "process-two" });
  assert.notEqual(second.processId, first.processId); assert.equal(second.participantId, first.participantId);
  assert.deepEqual(second.messages.map(m => m.text), ["Queued while the peer process was stopped"]);
  assert.equal((await owner.receive({ waitMs: 0 })).messages[0].text, "From process two");
  assert.equal(DB.sqlite.prepare("SELECT COUNT(*) AS n FROM link_participants_v2").get().n, 2);
  assert.equal((await owner.outbox("http-offline")).recipients[0].state, "received-by-client");
  await owner.close(); assert.equal(DB.sqlite.prepare("SELECT COUNT(*) AS n FROM link_messages_v2").get().n, 0);
});
