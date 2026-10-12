import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";
import test from "node:test";
import { createChatPostStatusTracker } from "../plugin/src/chat-post-status.mjs";
import { createLiveMirrorController } from "../plugin/src/live-mirror.mjs";

const template = await readFile(new URL("../plugin/ui/conversation-panel.html", import.meta.url), "utf8");
const script = template.match(/<script>([\s\S]*?)<\/script>/)[1]
  .replace("/* CODEX_LINK_LIVE_MIRROR_HELPER */", createLiveMirrorController.toString())
  .replace("/* CODEX_LINK_CHAT_POST_STATUS_HELPER */", createChatPostStatusTracker.toString());
const bootstrap = script.indexOf("      void (async () => {");
assert.ok(bootstrap > 0, "the synthetic panel harness must not run browser bootstrap or polling");

function panelHarness(behavior = "accepted") {
  const elements = new Map();
  const windowHandlers = new Map();
  const timers = new Map();
  const requests = [];
  let timerId = 0;
  let compatibilityCalls = 0;
  function element(selector = "") {
    return {
      value: "", textContent: "", dataset: {}, checked: false, listeners: new Map(),
      addEventListener(type, handler) { this.listeners.set(type, handler); },
      append(...items) { if (selector === "#sessionSelect" && !this.value) this.value = items[0]?.value || ""; },
      replaceChildren() { if (selector === "#sessionSelect") this.value = ""; },
      querySelectorAll() { return []; },
      scrollIntoView() {},
    };
  }
  const document = {
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, element(selector));
      return elements.get(selector);
    },
    querySelectorAll() { return []; },
    createElement() { return element(); },
    createTextNode(text) { return { textContent: text }; },
  };
  const sessionId = "synthetic-local-session";
  const roomState = {
    _meta: {
      sessions: [{ sessionId, roomId: "synthetic-room", isOwner: true, participants: [], expiresAt: "2099-01-01T00:00:00Z" }],
      transcriptSessionId: sessionId,
      transcript: [],
    },
  };
  const parent = {
    postMessage(request) {
      if (request.id === undefined) return;
      requests.push(request);
      if (request.method === "ui/message" && ["timeout", "pending"].includes(behavior)) return;
      const response = { jsonrpc: "2.0", id: request.id };
      if (request.method === "tools/call") response.result = roomState;
      else if (behavior === "rpc-error") response.error = { code: -32601, message: "Arbitrary host details must not enter diagnostics." };
      else if (behavior !== "malformed") response.result = behavior === "declined" ? { isError: true } : {};
      queueMicrotask(() => windowHandlers.get("message")({ source: parent, data: response }));
    },
  };
  const window = {
    parent,
    addEventListener(type, handler) { windowHandlers.set(type, handler); },
    openai: { async sendFollowUpMessage() { compatibilityCalls += 1; } },
  };
  const context = createContext({
    document, window,
    setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  runInContext(script.slice(0, bootstrap), context);
  runInContext("bridgeReady = true;", context);
  return {
    context, requests, elements,
    get compatibilityCalls() { return compatibilityCalls; },
    async refresh() { await runInContext("refreshState()", context); },
    post() { return runInContext(`postMessagesToChat("synthetic harmless message", ${JSON.stringify(sessionId)}, "manual")`, context); },
    async manualPost() {
      runInContext('selectedPost = "synthetic harmless manual selection";', context);
      await document.querySelector("#confirmPostButton").listeners.get("click")();
    },
    timeout() { for (const callback of [...timers.values()]) callback(); },
    get status() { return document.querySelector("#chatPostStatus").textContent; },
  };
}

test("chat-post diagnostics retain only fixed metadata, never errors, replies or credentials", () => {
  const tracker = createChatPostStatusTracker();
  const attempt = tracker.begin("room", { source: "mirror", channel: "ui/message", prompt: "synthetic private text" });
  assert.match(tracker.describe("room"), /waiting for the host response/);
  tracker.finish(attempt, Object.assign(new Error("synthetic private error"), { code: -32601, secret: "synthetic key" }));
  assert.deepEqual(tracker.get("room"), { attemptId: 1, source: "mirror", channel: "ui/message", state: "unconfirmed", reason: "method-unavailable" });
  assert.doesNotMatch(JSON.stringify(tracker.get("room")) + tracker.describe("room"), /synthetic private|synthetic key/);
  const copy = tracker.get("room");
  copy.state = "accepted";
  assert.equal(tracker.get("room").state, "unconfirmed");
});

test("chat-post diagnostics isolate rooms and ignore late or superseded completions", () => {
  const tracker = createChatPostStatusTracker();
  const old = tracker.begin("a");
  const latest = tracker.begin("a", { source: "mirror" });
  const other = tracker.begin("b", { source: "participate" });
  assert.equal(tracker.finish(old), false);
  assert.equal(tracker.get("a").state, "pending");
  tracker.finish(latest);
  assert.match(tracker.describe("a"), /accepted.*not verified.*not a reading receipt/);
  tracker.synchronizeSessions(["a"]);
  assert.equal(tracker.finish(other), false);
  assert.equal(tracker.get("b"), null);
});

test("the actual panel keeps manual host acceptance visible across polling refreshes", async () => {
  const panel = panelHarness();
  await panel.refresh();
  await panel.manualPost();
  const originalStatus = panel.status;
  assert.match(originalStatus, /manual selection, ui\/message.*accepted.*not verified/);
  await panel.refresh();
  await panel.refresh();
  assert.equal(panel.status, originalStatus);
  assert.equal(panel.requests.filter(request => request.method === "ui/message").length, 1);
});

test("the actual panel preserves a declined message without compatibility retry", async () => {
  const panel = panelHarness("declined");
  await panel.refresh();
  await assert.rejects(panel.post(), /declined/);
  await panel.refresh();
  assert.match(panel.status, /not confirmed.*host declined.*Do not automatically resend/);
  assert.equal(panel.compatibilityCalls, 0);
});

test("the actual panel retains safe JSON-RPC method errors across refreshes", async () => {
  const panel = panelHarness("rpc-error");
  await panel.refresh();
  await assert.rejects(panel.post(), /Arbitrary host details/);
  await panel.refresh();
  assert.match(panel.status, /does not expose.*-32601/);
  assert.doesNotMatch(panel.status, /Arbitrary host details/);
  assert.equal(panel.compatibilityCalls, 0);
});

test("a malformed host message response is not treated as acceptance", async () => {
  const panel = panelHarness("malformed");
  await panel.refresh();
  await assert.rejects(panel.post(), /missing its result/);
  await panel.refresh();
  assert.match(panel.status, /not confirmed.*malformed/);
  assert.equal(panel.compatibilityCalls, 0);
});

test("an ambiguous mirrored timeout is retained and never automatically resent", async () => {
  const panel = panelHarness("timeout");
  await panel.refresh();
  runInContext('liveMirror.enable("synthetic-local-session", []);', panel.context);
  const mirror = () => runInContext('liveMirror.mirror("synthetic-local-session", [{messageId:"synthetic-message",direction:"incoming",messageType:"human",text:"synthetic harmless message"}])', panel.context);
  const pending = mirror();
  assert.match(panel.status, /Live Mirror.*waiting/);
  panel.timeout();
  assert.equal((await pending).deliveryUnknown, true);
  await panel.refresh();
  assert.match(panel.status, /not confirmed.*timed out/);
  assert.equal((await mirror()).postedCount, 0);
  assert.equal(panel.requests.filter(request => request.method === "ui/message").length, 1);
  assert.equal(panel.compatibilityCalls, 0);
});

test("the optional compatibility bridge records acceptance without claiming chat visibility", async () => {
  const panel = panelHarness();
  await panel.refresh();
  runInContext("bridgeReady = false;", panel.context);
  await panel.post();
  assert.match(panel.status, /host compatibility bridge.*accepted.*not verified/);
  assert.equal(panel.compatibilityCalls, 1);
  assert.equal(panel.requests.filter(request => request.method === "ui/message").length, 0);
});
