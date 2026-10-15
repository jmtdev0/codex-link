import assert from "node:assert/strict";
import test from "node:test";
import { request as httpRequest } from "node:http";
import { Readable, Writable } from "node:stream";
import { readFile } from "node:fs/promises";
import { LinkClient } from "../link/client.mjs";
import { createLinkHttpServer } from "../link/http-server.mjs";
import { serveStdio } from "../link/stdio.mjs";
import { createRelayServer } from "../dev-relay/server.mjs";
import { startJsonProcess } from "./support/link-test-clients.mjs";

async function setup(t) {
  const relay = createRelayServer({ port: 0 });
  const address = await relay.listen();
  t.after(() => relay.close());
  return { relay, relayUrl: `http://127.0.0.1:${address.port}` };
}

async function gateway(t, relayUrl) {
  const api = createLinkHttpServer({ relayUrl });
  const credentials = await api.listen();
  t.after(() => api.close());
  return {
    ...credentials,
    async call(path = "", { method = "GET", body, token = credentials.bearerToken, headers: additional = {} } = {}) {
      const headers = { authorization: `Bearer ${token}`, ...additional };
      if (body !== undefined) headers["content-type"] = "application/json";
      const response = await fetch(`${credentials.baseUrl}${path}`, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, headers: response.headers, body: await response.json() };
    },
  };
}

test("loopback HTTP APIs exchange E2E messages without an OpenAI account, plugin, or global token", async (t) => {
  const { relayUrl } = await setup(t);
  const a = await gateway(t, relayUrl);
  const b = await gateway(t, relayUrl);
  const info = await a.call();
  assert.equal(info.body.result.automaticAgentParticipation, false);
  assert.equal((await a.call("/")).status, 200, "OpenAPI root route with a trailing slash is accepted");
  assert.equal(info.headers.get("cache-control"), "no-store");
  assert.equal(info.headers.has("access-control-allow-origin"), false);
  const created = await a.call("/rooms", { method: "POST", body: { displayName: "API A" } });
  assert.equal(created.status, 200);
  const room = created.body.result;
  const joined = await b.call("/join", { method: "POST", body: { invitationCode: room.invitationCode, displayName: "API B" } });
  assert.equal(joined.status, 200);
  assert.equal(Object.hasOwn(joined.body.result, "invitationCode"), false);
  const peer = joined.body.result;
  const sent = await a.call(`/sessions/${room.sessionId}/messages`, { method: "POST", body: { text: "hello over the local API", requestId: "api-hello" } });
  assert.equal(sent.body.result.accepted, true);
  const batch = await b.call(`/sessions/${peer.sessionId}/receive`, { method: "POST", body: { waitMs: 0 } });
  assert.equal(batch.body.result.messages[0].text, "hello over the local API");
  assert.equal(batch.body.result.untrusted, true);
  const ack = await b.call(`/sessions/${peer.sessionId}/ack`, { method: "POST", body: { messageIds: [sent.body.result.messageId] } });
  assert.equal(ack.body.result.acknowledged, 1);
  assert.equal((await a.call(`/sessions/${room.sessionId}`)).body.result.participantCount, 2);
  assert.equal((await b.call(`/sessions/${peer.sessionId}`, { method: "DELETE" })).body.result.roomLeft, true);
  assert.equal((await a.call(`/sessions/${room.sessionId}`, { method: "DELETE" })).body.result.roomClosed, true);
});

test("local API rejects unauthorized clients, browser origins, rebinding hosts, query secrets, and extra relay inputs", async (t) => {
  const { relayUrl, relay } = await setup(t);
  assert.throws(() => createLinkHttpServer({ relayUrl, host: "0.0.0.0" }), /127\.0\.0\.1/);
  assert.throws(() => createLinkHttpServer({ relayUrl, port: 65536 }), /port/);
  const api = await gateway(t, relayUrl);
  assert.equal((await api.call("/rooms", { method: "POST", body: {}, token: "wrong" })).status, 401);
  assert.equal((await api.call("", { headers: { origin: "https://untrusted.example.test" } })).status, 403);
  assert.equal((await api.call("?invitationCode=do-not-echo-this")).status, 400);
  const invalid = await api.call("/rooms", { method: "POST", body: { relayUrl: "https://untrusted.example.test" } });
  assert.equal(invalid.status, 400);
  assert.equal(relay.rooms.size, 0);
  const url = new URL(api.baseUrl);
  const rebinding = await new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: "127.0.0.1", port: url.port, path: "/link/v1", headers: {
      host: "rebinding.example.test", authorization: `Bearer ${api.bearerToken}`,
    } }, (response) => { response.resume(); response.on("end", () => resolve(response.statusCode)); });
    request.on("error", reject);
    request.end();
  });
  assert.equal(rebinding, 403);
  const created = (await api.call("/rooms", { method: "POST", body: {} })).body.result;
  assert.equal((await api.call(`/sessions/${created.sessionId}/receive`, { method: "POST", body: [] })).status, 400);
  assert.equal((await api.call(`/sessions/${created.sessionId}/receive`, { method: "POST", body: { sessionId: created.sessionId } })).status, 400);
  const oversized = await api.call("/join", { method: "POST", body: { invitationCode: "x".repeat(70_000) } });
  assert.equal(oversized.status, 413);
  assert.equal(JSON.stringify(oversized.body).includes("x".repeat(100)), false);
  const noJson = await fetch(`${api.baseUrl}/join`, { method: "POST", headers: { authorization: `Bearer ${api.bearerToken}` }, body: "untrusted private input" });
  assert.equal(noJson.status, 415);
  assert.equal((await noJson.text()).includes("untrusted private input"), false);
});

test("independent persistent JSON-lines processes can join, send, receive, ACK, and disconnect", async (t) => {
  const { relayUrl } = await setup(t);
  const a = startJsonProcess("../../link/stdio.mjs", relayUrl);
  const b = startJsonProcess("../../link/stdio.mjs", relayUrl);
  t.after(() => Promise.all([a.close(), b.close()]));
  const info = await a.request("info");
  assert.equal(info.result.apiVersion, "1.0");
  const room = (await a.request("create", { displayName: "JSON A" })).result;
  const peer = (await b.request("join", { invitationCode: room.invitationCode, displayName: "JSON B" })).result;
  const sent = (await a.request("send", { sessionId: room.sessionId, text: "from JSON-lines", requestId: "json-1" })).result;
  const received = (await b.request("receive", { sessionId: peer.sessionId })).result;
  assert.equal(received.messages[0].text, "from JSON-lines");
  assert.equal(received.messages[0].untrusted, true);
  assert.equal((await b.request("ack", { sessionId: peer.sessionId, messageIds: [sent.messageId] })).result.acknowledged, 1);
  assert.equal((await b.request("disconnect", { sessionId: peer.sessionId })).result.roomLeft, true);
  assert.equal((await a.request("disconnect", { sessionId: room.sessionId })).result.roomClosed, true);
});

test("JSON-lines handles bounded invalid input without echoing data and continues after each invalid line", async () => {
  const output = [];
  const input = Readable.from([
    Buffer.from("private invalid JSON\n"),
    Buffer.from(`${"x".repeat(70_000)}\n`),
    Buffer.from(`${JSON.stringify({ id: "safe", method: "unknown-private-method" })}\n`),
    Buffer.from(`${JSON.stringify({ id: 5, method: "info" })}\n`),
  ]);
  const sink = new Writable({ write(chunk, _encoding, callback) { output.push(Buffer.from(chunk)); callback(); } });
  await serveStdio({ input, output: sink });
  const serialized = Buffer.concat(output).toString("utf8");
  const responses = serialized.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(responses.map((response) => response.error?.code ?? "OK"), ["INVALID_JSON", "INPUT_TOO_LARGE", "METHOD_NOT_FOUND", "OK"]);
  assert.equal(serialized.includes("private"), false);
  assert.equal(responses[3].id, 5);
});

test("SDK registration fails closed on malformed successful relay responses", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ expiresAt: "not-a-date", invitationCode: "remote-secret-must-not-be-reflected" }), {
    headers: { "content-type": "application/json" },
  }));
  const client = new LinkClient({ relayUrl: "https://relay.example.test" });
  await assert.rejects(client.createRoom(), (error) => error.code === "INVALID_RELAY_RESPONSE" && !error.message.includes("remote-secret"));
});

test("OpenAPI contract declares only the authenticated local client surface, not a plaintext public relay", async () => {
  const spec = JSON.parse(await readFile(new URL("../link/openapi.json", import.meta.url), "utf8"));
  assert.equal(spec.openapi, "3.1.0");
  assert.deepEqual(spec.security, [{ localBearer: [] }]);
  assert.equal(spec.servers[0].url, "http://127.0.0.1:{port}/link/v1");
  assert.ok(spec.paths["/join"].post);
  assert.ok(spec.paths["/sessions/{sessionId}/ack"].post);
  assert.equal(JSON.stringify(spec).includes("api.openai.com"), false);
});
