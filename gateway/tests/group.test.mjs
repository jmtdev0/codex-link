import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createDurableLink } from "../worker/link-v2.js";
import { createLinkClient } from "../worker/link-client.js";
import { TestD1 } from "./support/d1.mjs";

const origin = "https://link.test";
const secret = () => "lks2." + randomBytes(32).toString("base64url");

function fixture(t) {
  const service = createDurableLink({ maxCreates: 100, maxRequests: 10000, maxIngress: 10000, pollMs: 5 });
  const DB = new TestD1(), env = { DB, LINK_GATEWAY_MASTER_KEY: randomBytes(32).toString("base64url") };
  t.after(() => DB.close());
  async function call(path, { credential, method = "GET", json } = {}) {
    const response = await service.fetch(new Request(origin + "/link/v1" + path, { method, headers: { "cf-connecting-ip": "synthetic-test",
      ...(credential ? { authorization: "Bearer " + credential } : {}), ...(json !== undefined ? { "content-type": "application/json" } : {}) },
      ...(json === undefined ? {} : { body: JSON.stringify(json) }) }), env);
    return { status: response.status, data: await response.json() };
  }
  async function room(names) {
    const owner = (await call("/rooms", { credential: secret(), method: "POST", json: { name: names[0], consentToPlaintextGateway: true } })).data;
    const members = [owner];
    for (const name of names.slice(1)) {
      const joined = await call("/join", { credential: secret(), method: "POST", json: { invitation: owner.invitation, name, consentToPlaintextGateway: true } });
      assert.equal(joined.status, 201, JSON.stringify(joined.data));
      members.push(joined.data);
    }
    return members;
  }
  const clientFetch = (input, init = {}) => service.fetch(new Request(input, { ...init, headers: { ...init.headers, "cf-connecting-ip": "synthetic-test" } }), env);
  return { call, room, DB, clientFetch };
}

test("participants lists the active members with names, roles and who you are", async t => {
  const f = fixture(t), [alice, bob, carol] = await f.room(["Alice", "Bob", "Carol"]);
  const list = await f.call("/participants", { credential: bob.credential });
  assert.equal(list.status, 200);
  assert.equal(list.data.count, 3);
  assert.equal(list.data.maxParticipants, 8);
  assert.equal(list.data.untrusted, true);
  assert.deepEqual(list.data.participants.map(p => [p.name, p.role, p.you]), [["Alice", "owner", false], ["Bob", "member", true], ["Carol", "member", false]]);
  assert.deepEqual(list.data.participants.map(p => p.participantId), [alice.participantId, bob.participantId, carol.participantId]);
  assert.equal((await f.call("/session", { credential: carol.credential })).data.maxParticipants, 8);
  assert.equal((await f.call("/session", { method: "DELETE", credential: carol.credential })).status, 200);
  const after = await f.call("/participants", { credential: alice.credential });
  assert.deepEqual(after.data.participants.map(p => p.name), ["Alice", "Bob"], "members who left are not listed");
  assert.equal((await f.call("/participants")).status, 401);
});

test("to addresses a message: everyone receives it, with the recipients and toYou", async t => {
  const f = fixture(t), [alice, bob, carol] = await f.room(["Alice", "Bob", "Carol"]);
  const sent = await f.call("/send", { credential: alice.credential, method: "POST", json: { text: "Bob, can you check?", requestId: "q1", to: [bob.participantId] } });
  assert.equal(sent.status, 202, JSON.stringify(sent.data));
  const forBob = (await f.call("/receive", { credential: bob.credential, method: "POST", json: {} })).data.messages[0];
  const forCarol = (await f.call("/receive", { credential: carol.credential, method: "POST", json: {} })).data.messages[0];
  assert.deepEqual(forBob.to, [{ participantId: bob.participantId, name: "Bob" }]);
  assert.equal(forBob.toYou, true);
  assert.deepEqual(forCarol.to, forBob.to);
  assert.equal(forCarol.toYou, false);
  const room = await f.call("/send", { credential: alice.credential, method: "POST", json: { text: "Hello everyone", requestId: "all" } });
  const plain = (await f.call("/receive", { credential: carol.credential, method: "POST", json: { cursor: 1 } })).data.messages[0];
  assert.equal(plain.messageId, room.data.messageId);
  assert.ok(!("to" in plain) && !("toYou" in plain), "messages without to are unchanged");
  const both = await f.call("/send", { credential: bob.credential, method: "POST", json: { text: "Both of you", requestId: "b1", to: [carol.participantId, alice.participantId] } });
  const history = (await f.call("/conversation", { credential: alice.credential, method: "POST", json: { cursor: 0 } })).data.messages;
  const entry = history.find(m => m.messageId === both.data.messageId);
  assert.deepEqual(entry.to.map(r => r.name).sort(), ["Alice", "Carol"]);
  assert.equal(entry.toYou, true);
  const stored = JSON.stringify(f.DB.sqlite.prepare("SELECT payload_ciphertext FROM link_messages_v2").all());
  assert.ok(!stored.includes(bob.participantId) && !stored.includes("Carol"), "recipients are encrypted at rest");
});

test("to is validated, and retries stay idempotent", async t => {
  const f = fixture(t), [alice, bob, carol] = await f.room(["Alice", "Bob", "Carol"]);
  const send = json => f.call("/send", { credential: alice.credential, method: "POST", json: { text: "Hi", ...json } });
  for (const to of [[], "x", [alice.participantId], [bob.participantId, bob.participantId], ["short"], Array(8).fill(bob.participantId)]) {
    assert.equal((await send({ requestId: "bad-" + randomBytes(3).toString("hex"), to })).status, 400, JSON.stringify(to));
  }
  const unknown = await send({ requestId: "unknown", to: ["A".repeat(22)] });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.data.error.code, "UNKNOWN_RECIPIENT");
  const first = await send({ requestId: "r1", to: [carol.participantId, bob.participantId] });
  const again = await send({ requestId: "r1", to: [bob.participantId, carol.participantId] });
  assert.equal(again.data.messageId, first.data.messageId, "the order of to does not matter");
  assert.equal(again.data.duplicate, true);
  assert.equal((await send({ requestId: "r1", to: [bob.participantId] })).status, 409, "same requestId with other recipients conflicts");
  assert.equal((await send({ requestId: "r1" })).status, 409);
  assert.equal((await f.call("/session", { method: "DELETE", credential: bob.credential })).status, 200);
  assert.equal((await send({ requestId: "r1", to: [carol.participantId, bob.participantId] })).data.messageId, first.data.messageId, "a retry still works after a recipient left");
  assert.equal((await send({ requestId: "r2", to: [bob.participantId] })).data.error.code, "UNKNOWN_RECIPIENT", "members who left cannot be addressed");
  const plain = await send({ requestId: "p1" }), plainAgain = await send({ requestId: "p1" });
  assert.equal(plainAgain.data.messageId, plain.data.messageId);
});

test("the client lists participants, sends with to and keeps to on retry", async t => {
  const f = fixture(t), [alice, bob] = await f.room(["Alice", "Bob"]);
  const client = createLinkClient({ baseUrl: origin, credential: alice.credential, fetch: f.clientFetch });
  await client.resume();
  const { participants } = await client.participants();
  const peer = participants.find(p => !p.you);
  assert.equal(peer.name, "Bob");
  const result = await client.send("Your turn", { to: [peer.participantId], requestId: "turn-1" });
  assert.equal(result.accepted, true);
  const got = (await f.call("/receive", { credential: bob.credential, method: "POST", json: {} })).data.messages[0];
  assert.equal(got.toYou, true);
  await assert.rejects(client.send("x", { to: "nope" }), /participantIds/);
  const info = await f.call("/info");
  assert.equal(info.data.participantList, true);
  assert.equal(info.data.addressing, true);
});
