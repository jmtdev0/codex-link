import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createGateway } from "../worker/index.js";
import { TestD1, memoryRelay } from "./support/d1.mjs";

const origin = "https://link.test";
const random = () => randomBytes(32).toString("base64url");
function fixture(t) {
  let clock = Date.now();
  const DB = new TestD1(), env = { DB, LINK_GATEWAY_MASTER_KEY: random() };
  const gateway = createGateway({ now: () => clock, fetchRelay: memoryRelay(() => clock), maxCreates: 100, maxSessions: 100, maxRequests: 10000, maxIngress: 10000 });
  t.after(() => DB.close());
  async function call(path, { method = "GET", body, token, cookie, headers = {}, ip = "test-network-a" } = {}) {
    const response = await gateway.fetch(new Request(origin + path, { method, headers: { "cf-connecting-ip": ip,
      ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: "Bearer " + token } : {}),
      ...(cookie ? { cookie } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined }), env);
    const type = response.headers.get("content-type") ?? "";
    const data = type.startsWith("application/json") ? await response.json() : await response.text();
    return { response, data, status: response.status };
  }
  const imported = (overrides = {}) => ({ title: "Private synthetic transcript", messages: [
    { id: "a-1", speaker: "Agent A", text: "HISTORY_PRIVATE_CANARY: á, ñ, 🔐" },
    { id: "b-1", speaker: "Agent B", text: "A synthetic reply." },
  ], ttlMinutes: 60, importKey: random(), consentToStoreHistory: true, ...overrides });
  return { DB, env, gateway, call, imported, setTime: value => { clock = value; }, advance: ms => { clock += ms; } };
}
const read = (f, history, token = history.readerCredential, extra = {}) =>
  f.call("/history/v1/" + history.historyId, { token, ...extra });

test("private imported history has clean URLs, encrypted storage and isolated access", async t => {
  const f = fixture(t), result = await f.call("/history/v1/import", { method: "POST", body: f.imported() });
  assert.equal(result.status, 201); const h = result.data;
  assert.match(h.viewerPath, /^\/rooms\/[A-Za-z0-9_-]{22}$/);
  assert.equal(h.viewerPath.includes(h.readerCredential), false);
  assert.match(h.readerCredential, /^lhr1\.[A-Za-z0-9_-]{43}$/);
  assert.match(h.manageCredential, /^lha1\.[A-Za-z0-9_-]{43}$/);
  assert.equal((await f.call("/history/v1/" + h.historyId)).status, 401);
  assert.equal((await read(f, h, "lhr1." + random())).status, 401);
  const own = await read(f, h);
  assert.equal(own.status, 200); assert.equal(own.data.messages.length, 2); assert.equal(own.data.role, "reader");
  const stored = JSON.stringify(f.DB.prepare("SELECT * FROM link_gateway_histories").all()) + JSON.stringify(f.DB.prepare("SELECT * FROM link_gateway_history_messages").all());
  for (const secret of [h.readerCredential, h.manageCredential, "HISTORY_PRIVATE_CANARY", "Private synthetic transcript"]) assert.equal(stored.includes(secret), false);
  for (const path of ["/", "/rooms", h.viewerPath, "/guide"]) {
    const page = await f.call(path); assert.equal(page.status, 200);
    assert.equal(page.data.includes("HISTORY_PRIVATE_CANARY"), false);
  }
});

test("read access cannot read another room, manage history, or send relay messages", async t => {
  const f = fixture(t);
  const a = (await f.call("/history/v1/import", { method: "POST", body: f.imported() })).data;
  const b = (await f.call("/history/v1/import", { method: "POST", body: f.imported({ title: "Other room" }) })).data;
  assert.equal((await read(f, b, a.readerCredential)).status, 401);
  assert.equal((await f.call("/history/v1/" + a.historyId, { method: "DELETE", token: a.readerCredential })).status, 401);
  assert.equal((await f.call("/history/v1/" + a.historyId + "/access", { method: "POST", body: {}, token: a.readerCredential })).status, 401);
  assert.equal((await f.call("/bridge/v1/messages", { method: "POST", body: { text: "not allowed", requestId: "no" }, token: a.readerCredential })).status, 401);
  assert.equal((await read(f, a)).data.messageCount, 2);
});

test("history expiry is absolute, purged on activity, and cannot be renewed by reads", async t => {
  const f = fixture(t), body = f.imported();
  const h = (await f.call("/history/v1/import", { method: "POST", body })).data;
  const expiry = Date.parse(h.expiresAt);
  f.advance(30 * 60000);
  assert.equal((await read(f, h)).data.expiresAt, h.expiresAt);
  f.setTime(expiry + 1);
  assert.ok([401, 410].includes((await read(f, h)).status));
  assert.equal(f.DB.prepare("SELECT COUNT(*) AS n FROM link_gateway_history_messages").first("n"), 0);
  assert.equal(f.DB.prepare("SELECT COUNT(*) AS n FROM link_gateway_histories").first("n"), 0);
  const fresh = (await f.call("/history/v1/import", { method: "POST", body })).data;
  assert.notEqual(fresh.historyId, h.historyId);
  assert.equal((await read(f, h)).status, 401);
});

test("imports require consent, bounded fields, unique IDs, valid retention and content limits", async t => {
  const f = fixture(t);
  const bodies = [
    f.imported({ consentToStoreHistory: false }), f.imported({ ttlMinutes: 1441 }),
    f.imported({ messages: [] }), f.imported({ messages: [{ id: "same", speaker: "A", text: "a" }, { id: "same", speaker: "B", text: "b" }] }),
    f.imported({ messages: [{ id: "long", speaker: "A", text: "a".repeat(8193) }] }),
    f.imported({ importKey: "not-a-key" }), f.imported({ unexpected: true }),
    f.imported({ messages: [{ id: "x", speaker: "A", text: "x", timestamp: "bad" }] }),
  ];
  for (const [i, body] of bodies.entries()) {
    const result = await f.call("/history/v1/import", { method: "POST", body, ip: "validation-network-" + i });
    assert.equal(result.status, 400);
  }
  assert.equal(f.DB.prepare("SELECT COUNT(*) AS n FROM link_gateway_histories").first("n"), 0);
});

test("same import recovery is idempotent, immutable, and limited to five minutes", async t => {
  const f = fixture(t), body = f.imported();
  const one = (await f.call("/history/v1/import", { method: "POST", body })).data;
  const two = (await f.call("/history/v1/import", { method: "POST", body })).data;
  assert.equal(two.historyId, one.historyId); assert.equal(two.readerCredential, one.readerCredential);
  assert.equal((await read(f, one)).data.messageCount, 2);
  assert.equal((await f.call("/history/v1/import", { method: "POST", body: { ...body, title: "Changed" } })).status, 409);
  f.advance(300001);
  assert.equal((await f.call("/history/v1/import", { method: "POST", body })).status, 409);
});

test("browser unlock uses scoped HttpOnly cookies, rejects CSRF and never needs URL secrets", async t => {
  const f = fixture(t);
  const created = await f.call("/history/v1/import", { method: "POST", body: f.imported() }), h = created.data;
  const cookies = created.response.headers.getSetCookie();
  assert.equal(cookies.length, 2);
  assert.ok(cookies.every(c => /; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=/.test(c)));
  const path = "/history/v1/" + h.historyId + "/unlock";
  assert.equal((await f.call(path, { method: "POST", body: { readerCredential: h.readerCredential } })).status, 403);
  assert.equal((await f.call(path, { method: "POST", body: { readerCredential: h.readerCredential }, headers: { origin: "https://evil.test" } })).status, 403);
  const unlocked = await f.call(path, { method: "POST", body: { readerCredential: h.readerCredential }, headers: { origin } });
  assert.equal(unlocked.status, 200);
  const cookie = unlocked.response.headers.getSetCookie()[0].split(";")[0];
  assert.equal((await f.call("/history/v1/" + h.historyId, { cookie })).status, 200);
  assert.equal((await f.call("/history/v1/" + h.historyId + "/messages", { method: "POST", cookie, body: { after: 0 } })).status, 403);
  assert.equal((await f.call("/history/v1/" + h.historyId + "/messages", { method: "POST", cookie, body: { after: 0 }, headers: { origin } })).status, 200);
  assert.equal((await f.call("/history/v1/" + h.historyId + "?key=" + h.readerCredential)).status, 400);
  const locked = await f.call("/history/v1/" + h.historyId + "/lock", { method: "POST", body: {}, headers: { origin } });
  assert.equal(locked.status, 200);
  assert.ok(locked.response.headers.getSetCookie().every(c => c.includes("Max-Age=0")));
});

test("history pagination is bounded and opening the viewer does not consume history", async t => {
  const f = fixture(t);
  const messages = Array.from({ length: 55 }, (_, i) => ({ id: "entry-" + i, speaker: i % 2 ? "B" : "A", text: "Entry " + i }));
  const h = (await f.call("/history/v1/import", { method: "POST", body: f.imported({ messages }) })).data;
  const page = await read(f, h);
  assert.equal(page.data.messages.length, 40); assert.equal(page.data.more, true); assert.equal(page.data.messageCount, 55);
  const second = await f.call("/history/v1/" + h.historyId + "/messages", { method: "POST", token: h.readerCredential, body: { after: page.data.nextCursor } });
  assert.equal(second.data.messages.length, 15); assert.equal(second.data.more, false);
  assert.equal((await read(f, h)).data.messages[0].id, messages[0].id);
  assert.equal(f.DB.prepare("SELECT COUNT(*) AS n FROM link_gateway_history_messages").first("n"), 55);
});

test("deleting one history revokes its access and preserves other rooms", async t => {
  const f = fixture(t);
  const a = (await f.call("/history/v1/import", { method: "POST", body: f.imported() })).data;
  const b = (await f.call("/history/v1/import", { method: "POST", body: f.imported() })).data;
  assert.equal((await f.call("/history/v1/" + a.historyId, { method: "DELETE", token: a.manageCredential })).status, 200);
  assert.equal((await read(f, a)).status, 401); assert.equal((await read(f, b)).status, 200);
  assert.equal(f.DB.prepare("SELECT COUNT(*) AS n FROM link_gateway_history_messages WHERE history_id = ?").bind(a.historyId).first("n"), 0);
});

test("untrusted message markup stays data and is absent from public shells", async t => {
  const f = fixture(t), text = '<img src=x onerror="alert(1)"><script>bad()</script>';
  const h = (await f.call("/history/v1/import", { method: "POST", body: f.imported({ title: "<script>private title</script>", messages: [{ id: "xss", speaker: "<img>", text }] }) })).data;
  assert.equal((await read(f, h)).data.messages[0].text, text);
  const shell = await f.call(h.viewerPath);
  assert.equal(shell.data.includes(text), false);
  assert.match(shell.response.headers.get("content-security-policy"), /script-src 'self'/);
  const client = (await f.call("/history-client.js")).data;
  assert.equal(client.includes("innerHTML"), false); assert.match(client, /text\.textContent = message\.text/);
});

test("opt-in live room history records both directions, deduplicates and survives message ACKs", async t => {
  const f = fixture(t);
  const owner = (await f.call("/bridge/v1/rooms", { method: "POST", body: { displayName: "Owner", consentToPlaintextGateway: true, provisioningKey: random() } })).data;
  const guest = (await f.call("/bridge/v1/sessions", { method: "POST", body: { invitationCode: owner.invitationCode, displayName: "Guest", ttlMinutes: 60, consentToPlaintextGateway: true, provisioningKey: random() } })).data;
  assert.equal((await f.call("/bridge/v1/history", { method: "POST", token: guest.credential, body: { consentToStoreHistory: true } })).status, 403);
  assert.equal((await f.call("/bridge/v1/history", { method: "POST", token: owner.credential, body: { consentToStoreHistory: false } })).status, 400);
  const enabled = await f.call("/bridge/v1/history", { method: "POST", token: owner.credential, body: { title: "Live test room", ttlMinutes: 1440, consentToStoreHistory: true } });
  assert.equal(enabled.status, 200); const h = enabled.data;
  assert.ok(Date.parse(h.expiresAt) <= Date.parse(owner.roomExpiresAt));
  const sent = await f.call("/bridge/v1/messages", { method: "POST", token: owner.credential, body: { text: "A live greeting.", requestId: "greeting-1" } });
  assert.equal(sent.status, 202); assert.equal(sent.data.history.status, "recorded");
  const incoming = await f.call("/bridge/v1/receive", { method: "POST", token: guest.credential, body: {} });
  assert.equal(incoming.data.messages[0].text, "A live greeting.");
  await f.call("/bridge/v1/acks", { method: "POST", token: guest.credential, body: { messageIds: [sent.data.messageId] } });
  const back = await f.call("/bridge/v1/messages", { method: "POST", token: guest.credential, body: { text: "A live reply.", requestId: "reply-1", messageType: "agent_reply", inReplyTo: sent.data.messageId } });
  assert.equal(back.status, 202);
  await f.call("/bridge/v1/receive", { method: "POST", token: owner.credential, body: {} });
  assert.equal((await read(f, h)).data.messageCount, 2);
  assert.deepEqual((await read(f, h)).data.messages.map(m => m.text), ["A live greeting.", "A live reply."]);
  const repeated = await f.call("/bridge/v1/history", { method: "POST", token: owner.credential, body: { consentToStoreHistory: true } });
  assert.equal(repeated.data.historyId, h.historyId); assert.equal(repeated.data.expiresAt, h.expiresAt);
  const status = await f.call("/bridge/v1/status", { token: guest.credential });
  assert.equal(status.data.privateHistory.enabled, true);
  await f.call("/bridge/v1/room", { method: "DELETE", token: owner.credential });
  assert.equal((await read(f, h)).data.messageCount, 2, "Closing the relay does not silently delete the opted-in archive.");
});

test("legacy messaging has no history without explicit owner opt-in", async t => {
  const f = fixture(t);
  const owner = (await f.call("/bridge/v1/rooms", { method: "POST", body: { consentToPlaintextGateway: true, provisioningKey: random() } })).data;
  const sent = await f.call("/bridge/v1/messages", { method: "POST", token: owner.credential, body: { text: "Not archived.", requestId: "legacy" } });
  assert.equal(sent.status, 202); assert.equal(sent.data.history, undefined);
  assert.equal(f.DB.prepare("SELECT COUNT(*) AS n FROM link_gateway_histories").first("n"), 0);
});

test("history write failures are visible but do not turn accepted relay sends into retries", async t => {
  const f = fixture(t);
  const owner = (await f.call("/bridge/v1/rooms", { method: "POST", body: { consentToPlaintextGateway: true, provisioningKey: random() } })).data;
  const guest = (await f.call("/bridge/v1/sessions", { method: "POST", body: { invitationCode: owner.invitationCode, consentToPlaintextGateway: true, provisioningKey: random() } })).data;
  const h = (await f.call("/bridge/v1/history", { method: "POST", token: owner.credential, body: { consentToStoreHistory: true } })).data;
  const prepare = f.DB.prepare.bind(f.DB);
  f.DB.prepare = sql => { if (sql.startsWith("INSERT OR IGNORE INTO link_gateway_history_messages")) throw new Error("Synthetic archive write failure"); return prepare(sql); };
  const sent = await f.call("/bridge/v1/messages", { method: "POST", token: owner.credential, body: { text: "Delivered despite archive failure.", requestId: "archive-failure" } });
  assert.equal(sent.status, 202); assert.equal(sent.data.accepted, true); assert.equal(sent.data.history.status, "unavailable");
  f.DB.prepare = prepare;
  const received = await f.call("/bridge/v1/receive", { method: "POST", token: guest.credential, body: {} });
  assert.equal(received.data.messages[0].text, "Delivered despite archive failure.");
  assert.equal((await read(f, h)).data.recordingIncomplete, true);
});

test("history capacity is bounded and does not stop ordinary messaging", async t => {
  const f = fixture(t);
  const owner = (await f.call("/bridge/v1/rooms", { method: "POST", body: { consentToPlaintextGateway: true, provisioningKey: random() } })).data;
  const members = [owner];
  for (let n = 0; n < 6; n++) members.push((await f.call("/bridge/v1/sessions", { method: "POST", body: { invitationCode: owner.invitationCode, displayName: "Test agent " + n, consentToPlaintextGateway: true, provisioningKey: random() } })).data);
  const h = (await f.call("/bridge/v1/history", { method: "POST", token: owner.credential, body: { consentToStoreHistory: true } })).data;
  for (let n = 0; n <= 200; n++) {
    const sent = await f.call("/bridge/v1/messages", { method: "POST", token: members[n % members.length].credential, body: { text: "Synthetic entry " + n, requestId: "cap-" + n } });
    assert.equal(sent.status, 202);
    assert.equal(sent.data.history.status, n < 200 ? "recorded" : "full");
  }
  const history = await read(f, h);
  assert.equal(history.data.messageCount, 200); assert.equal(history.data.recordingIncomplete, true);
});

test("concurrent same-key imports cannot create duplicates or cross audiences", async t => {
  const f = fixture(t), body = f.imported();
  const responses = await Promise.all([f.call("/history/v1/import", { method: "POST", body }), f.call("/history/v1/import", { method: "POST", body })]);
  assert.ok(responses.every(r => r.status === 201));
  assert.equal(responses[0].data.historyId, responses[1].data.historyId);
  assert.equal((await read(f, responses[0].data)).data.messageCount, 2);
  const other = await f.gateway.fetch(new Request("https://other.test/history/v1/" + responses[0].data.historyId,
    { headers: { authorization: "Bearer " + responses[0].data.readerCredential, "cf-connecting-ip": "other-origin" } }), f.env);
  assert.equal(other.status, 401);
});
