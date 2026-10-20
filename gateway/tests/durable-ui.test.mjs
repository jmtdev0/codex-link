import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { durableBrowserClient, durableLanding, durableOpenAPI } from "../worker/link-pages.js";

function fixture(messages = []) {
  class Element {
    children = []; dataset = {}; value = ""; textContent = ""; hidden = false;
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    insertBefore(node, before) { const index = this.children.indexOf(before); if (index < 0) this.children.push(node); else this.children.splice(index, 0, node); }
    querySelector() { return new Element(); }
  }
  const elements = new Map(), get = id => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  };
  get("create-name").value = "Synthetic owner"; get("create-ttl").value = "1440";
  get("durable-consent").checked = true;
  const session = { participantId: "synthetic-owner", name: "Synthetic owner", role: "owner", participantCount: 1,
    serverTime: new Date().toISOString(), expiresAt: new Date(Date.now() + 14 * 86400000).toISOString(), maxMessages: 2000 };
  const cursors = [], inputs = []; let exists = false;
  const client = {
    resume: async () => { if (!exists) throw Object.assign(new Error("No synthetic session"), { status: 401 }); return session; },
    create: async input => { inputs.push(input); exists = true; return { ...session, invitation: "synthetic-placeholder" }; },
    conversation: async cursor => {
      cursors.push(cursor);
      const available = messages.filter(message => message.sequence > cursor), page = available.slice(0, 50);
      return { messages: page, nextCursor: page.at(-1)?.sequence ?? cursor, more: available.length > 50 };
    },
    lockBrowser: async () => {},
  };
  runInNewContext("(" + durableBrowserClient.toString() + ")(createLinkClient)", {
    createLinkClient: () => client, location: { origin: "https://link.test" },
    document: { visibilityState: "hidden", getElementById: get, createElement: () => new Element(), querySelectorAll: () => [], addEventListener() {} },
    window: { addEventListener() {} }, navigator: { clipboard: { writeText: async () => {} } },
    setInterval: () => 1, clearInterval() {}, AbortController, queueMicrotask,
  });
  async function settle(until) {
    for (let n = 0; n < 100 && !until(); n++) await new Promise(resolve => setImmediate(resolve));
    assert.ok(until(), "the synthetic UI operation must complete");
  }
  const start = async () => {
    await new Promise(resolve => setImmediate(resolve));
    get("durable-create").onsubmit({ preventDefault() {} });
    await settle(() => cursors.length > 0 && get("conversation").children.length === messages.length);
  };
  return { get, start, cursors, inputs, messages };
}

test("room creation exposes a fourteen-day option while retaining the twenty-four-hour default", async () => {
  const html = await durableLanding().text();
  assert.match(html, /<option value="1440" selected>24 hours<\/option>/);
  assert.match(html, /<option value="20160">14 days<\/option>/);
  assert.match(html, /2,000 messages or 1 MiB/);
  const api = durableOpenAPI("https://link.test");
  assert.equal(api.info.version, "0.13.0");
  const ttl = api.paths["/rooms"].post.requestBody.content["application/json"].schema.properties.ttlMinutes;
  assert.equal(ttl.default, 1440); assert.equal(ttl.maximum, 20160);
  const f = fixture(); f.get("create-ttl").value = "20160"; await f.start();
  assert.equal(f.inputs[0].ttlMinutes, 20160);
  assert.equal(f.inputs[0].name, "Synthetic owner");
});

test("the browser replays all two thousand messages and refreshes incrementally without rereading the log", async () => {
  const messages = Array.from({ length: 2000 }, (_, index) => ({ sequence: index + 1, messageId: "synthetic-" + index,
    participantId: index % 2 ? "synthetic-peer" : "synthetic-owner", name: "Test participant", text: "Harmless synthetic entry " + index,
    timestamp: new Date().toISOString() }));
  const f = fixture(messages); await f.start();
  assert.equal(f.cursors.length, 40); assert.equal(f.cursors[0], 0); assert.equal(f.cursors.at(-1), 1950);
  assert.equal(f.get("conversation").children.length, 2000);
  await f.get("refresh-conversation").onclick();
  assert.equal(f.cursors.length, 41); assert.equal(f.cursors.at(-1), 2000);
  assert.equal(f.get("conversation").children.length, 2000);
  assert.equal(f.get("conversation").children[0].dataset.sequence, 1);
  assert.equal(f.get("conversation").children.at(-1).dataset.sequence, 2000);
});

test("incremental history includes new own and peer messages without duplicate cards", async () => {
  const messages = [{ sequence: 1, messageId: "one", participantId: "synthetic-owner", name: "Owner", text: "First", timestamp: new Date().toISOString() }];
  const f = fixture(messages); await f.start();
  messages.push({ ...messages[0], sequence: 2, messageId: "two", text: "Own follow-up" },
    { ...messages[0], sequence: 3, messageId: "three", participantId: "synthetic-peer", text: "Peer reply" });
  await f.get("refresh-conversation").onclick();
  await f.get("refresh-conversation").onclick();
  assert.deepEqual(f.cursors, [0, 1, 3]);
  assert.equal(f.get("conversation").children.length, 3);
  assert.match(f.get("conversation").children[1].className, /own/);
});
