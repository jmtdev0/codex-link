import test, { before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { createPostgresStore } from "../lib/postgres.mjs";
import { ensureSchema } from "../lib/schema.mjs";
import { createNetlifyService, PUBLIC_ORIGIN } from "../lib/service.mjs";

const connectionString = process.env.LINK_TEST_DATABASE_URL;
if (!connectionString) throw new Error("Set LINK_TEST_DATABASE_URL to an isolated loopback PostgreSQL database");
const parsed = new URL(connectionString);
if (!["127.0.0.1", "localhost"].includes(parsed.hostname) || parsed.pathname !== "/link_netlify_test") throw new Error("Refusing to test against a non-isolated database");
const pool = new pg.Pool({ connectionString, max: 12, idleTimeoutMillis: 1000, connectionTimeoutMillis: 5000 });
let clock, handler;
const key = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
const credential = () => "lks2." + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
const makeHandler = options => createNetlifyService({ getPool: () => pool, masterKey: () => key, now: () => clock, serviceOptions: { maxCreates: 1000, maxIngress: 100000, maxRequests: 100000, pollMs: 5, ...options } });
async function call(path, { token, method = "POST", body = {}, headers = {}, ip = "isolated-test-address" } = {}) {
  const request = new Request(PUBLIC_ORIGIN + "/link/v1" + path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}), ...headers }, ...(method === "GET" || method === "DELETE" ? {} : { body: JSON.stringify(body) }) });
  const response = await handler(request, { ip });
  return { status: response.status, data: await response.json(), headers: response.headers };
}
const create = (token = credential(), input = {}) => call("/rooms", { token, body: { name: "Synthetic owner", consentToPlaintextGateway: true, ...input } }).then(result => ({ ...result, token }));
const join = (owner, token = credential()) => call("/join", { token, body: { invitation: owner.data.invitation, name: "Synthetic peer", consentToPlaintextGateway: true } }).then(result => ({ ...result, token }));
before(async () => { await ensureSchema(pool); });
beforeEach(async () => {
  await pool.query("TRUNCATE link_rooms_v2, link_gateway_limits CASCADE");
  clock = Date.now(); handler = makeHandler();
});
after(() => pool.end());

test("schema is additive, idempotent and fingerprint-checked", async () => {
  await ensureSchema(pool);
  assert.equal((await pool.query("SELECT COUNT(*) AS n FROM link_schema_migrations")).rows[0].n, "1");
  await assert.rejects(ensureSchema(pool, "SELECT 1"), /fingerprint/);
});

test("create, join, send, receive, receipt, replay and cold-instance resume", async () => {
  const owner = await create(undefined, { ttlMinutes: 20160 }); assert.equal(owner.status, 201);
  const peer = await join(owner); assert.equal(peer.status, 201);
  const sent = await call("/send", { token: owner.token, body: { text: "Synthetic persistent greeting", requestId: "persistent-one" } }); assert.equal(sent.status, 202);
  const received = await call("/receive", { token: peer.token }); assert.equal(received.status, 200); assert.equal(received.data.messages[0].text, "Synthetic persistent greeting");
  assert.equal((await call("/confirm", { token: peer.token, body: { cursor: received.data.nextCursor, read: true } })).status, 200);
  const receipt = await call("/outbox/persistent-one", { token: owner.token, method: "GET" }); assert.equal(receipt.data.recipients[0].state, "read-confirmed");
  handler = makeHandler();
  assert.equal((await call("/session", { token: peer.token, method: "GET" })).data.participantId, peer.data.participantId);
  assert.equal((await call("/conversation", { token: peer.token })).data.messages.length, 1);
  assert.equal((await call("/receive", { token: peer.token })).data.messages.length, 0);
  const stored = JSON.stringify((await pool.query("SELECT * FROM link_messages_v2")).rows);
  assert.ok(!stored.includes("Synthetic persistent greeting")); assert.ok(!stored.includes("Synthetic owner"));
  assert.equal(Date.parse(owner.data.expiresAt) - clock, 20160 * 60000);
});

test("concurrent identical sends and setup retries do not duplicate records", async () => {
  const token = credential();
  const owners = await Promise.all(Array.from({ length: 4 }, () => create(token)));
  assert.ok(owners.every(result => result.status === 201)); assert.equal(new Set(owners.map(result => result.data.roomId)).size, 1);
  const sends = await Promise.all(Array.from({ length: 8 }, () => call("/send", { token, body: { text: "Synthetic duplicate", requestId: "same-send" } })));
  assert.ok(sends.every(result => result.status === 202)); assert.equal(new Set(sends.map(result => result.data.messageId)).size, 1);
  assert.equal((await pool.query("SELECT COUNT(*) AS n FROM link_messages_v2")).rows[0].n, "1");
  assert.equal((await call("/send", { token, body: { text: "Changed payload", requestId: "same-send" } })).status, 409);
});

test("concurrent distinct sends allocate unique consecutive sequences", async () => {
  const owner = await create();
  const results = await Promise.all(Array.from({ length: 16 }, (_, i) => call("/send", { token: owner.token, body: { text: "Synthetic sequence " + i, requestId: "seq-" + i } })));
  assert.ok(results.every(result => result.status === 202), JSON.stringify(results.map(result => ({ status: result.status, error: result.data.error }))));
  assert.deepEqual(results.map(result => result.data.sequence).sort((a, b) => a - b), Array.from({ length: 16 }, (_, i) => i + 1));
});

test("long polling never holds a transaction lock that blocks a send", async () => {
  const owner = await create(), peer = await join(owner);
  const waiting = call("/receive", { token: peer.token, body: { waitMs: 600 } });
  await new Promise(resolve => setTimeout(resolve, 40));
  const sent = await call("/send", { token: owner.token, body: { text: "Synthetic during wait", requestId: "during-wait" } });
  assert.equal(sent.status, 202);
  const result = await waiting; assert.equal(result.status, 200); assert.equal(result.data.messages[0].text, "Synthetic during wait");
});

test("authorization, origin, closure and expiry are enforced", async () => {
  const owner = await create(), peer = await join(owner), other = await create();
  const message = await call("/send", { token: owner.token, body: { text: "Synthetic private room", requestId: "private" } }); assert.equal(message.status, 202);
  assert.equal((await call("/conversation", { token: other.token })).data.messages.length, 0);
  assert.equal((await call("/conversation", { token: peer.token, headers: { origin: "https://evil.example" } })).status, 403);
  assert.equal((await call("/room", { token: peer.token, method: "DELETE" })).status, 403);
  assert.equal((await call("/room", { token: owner.token, method: "DELETE" })).status, 200);
  assert.equal((await call("/receive", { token: peer.token })).status, 410);
  clock += 86400001;
  assert.ok([401, 410].includes((await call("/session", { token: other.token, method: "GET" })).status));
  assert.equal((await pool.query("SELECT COUNT(*) AS n FROM link_rooms_v2")).rows[0].n, "0");
});

test("server-derived source rate keys ignore forged request headers", async () => {
  handler = makeHandler({ maxIngress: 2 });
  const owner = await create(); assert.equal(owner.status, 201);
  assert.equal((await call("/session", { token: owner.token, method: "GET", headers: { "cf-connecting-ip": "first-forgery" } })).status, 200);
  assert.equal((await call("/session", { token: owner.token, method: "GET", headers: { "cf-connecting-ip": "second-forgery" } })).status, 429);
});

test("message cap is atomic at the 2000-message boundary", async () => {
  const owner = await create();
  await pool.query("INSERT INTO link_messages_v2 (sequence,room_id,sender_id,message_id,request_id,fingerprint,payload_ciphertext,size_bytes,created_at) SELECT n,$1,$2,'synthetic-'||n,'seed-'||n,'synthetic','synthetic',1,$3 FROM generate_series(1,1999) n", [owner.data.roomId, owner.data.participantId, clock]);
  const results = await Promise.all(["boundary-a", "boundary-b"].map(requestId => call("/send", { token: owner.token, body: { text: "Synthetic final slot", requestId } })));
  assert.deepEqual(results.map(result => result.status).sort(), [202, 429]);
  assert.equal((await pool.query("SELECT COUNT(*) AS n FROM link_messages_v2")).rows[0].n, "2000");
});

test("adapter reports changes and normalizes integers without exposing parameters", async () => {
  const store = createPostgresStore(pool);
  const result = await store.prepare("INSERT INTO link_gateway_limits (bucket_key,window_started_at,request_count) VALUES (?,?,?)").bind("synthetic", clock, 1).run();
  assert.equal(result.meta.changes, 1);
  assert.equal(typeof (await store.prepare("SELECT window_started_at FROM link_gateway_limits WHERE bucket_key = ?").bind("synthetic").first()).window_started_at, "number");
});
