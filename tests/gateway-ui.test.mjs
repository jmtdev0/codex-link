import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { Script } from "node:vm";
import test from "node:test";
import worker from "../gateway/worker/index.js";

async function ui(responses = []) {
  const script = await (await worker.fetch(new Request("https://gateway.example.test/gateway-client.js"))).text();
  const html = await (await worker.fetch(new Request("https://gateway.example.test/legacy"))).text();
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  const elements = Object.fromEntries(ids.map(id => [id, { value: "", hidden: ["secret", "retry", "owner-secret", "host-retry"].includes(id), disabled: false, checked: false, textContent: "" }]));
  Object.assign(elements.invite, { value: "synthetic-nonfunctional-invitation" });
  Object.assign(elements.name, { value: "Synthetic UI test" });
  Object.assign(elements.ttl, { value: "60" });
  Object.assign(elements.consent, { checked: true });
  Object.assign(elements["host-name"], { value: "Synthetic UI host" });
  Object.assign(elements["host-consent"], { checked: true });
  const requests = [], copied = [], listeners = {}, timers = new Map();
  let nextTimer = 1;
  const sandbox = {
    document: { getElementById: id => elements[id] }, window: { location: { origin: "https://gateway.example.test" }, addEventListener: (name, handler) => { listeners[name] = handler; } },
    crypto: webcrypto, btoa: value => Buffer.from(value, "binary").toString("base64"), Uint8Array,
    setTimeout: handler => { const id = nextTimer++; timers.set(id, handler); return id; }, clearTimeout: id => timers.delete(id),
    navigator: { clipboard: { async writeText(value) { copied.push(value); } } },
    async fetch(path, init) {
      requests.push({ path, init });
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return { ok: response?.ok ?? true, async json() { return response?.body ?? { credential: "synthetic-nonfunctional-credential", expiresAt: "synthetic expiry" }; } };
    },
  };
  new Script(script).runInNewContext(sandbox);
  const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
  return { elements, requests, copied, listeners, timers, flush };
}

test("gateway UI uses masked credential fields, off-by-default consent, no inline scripts or external resources", async () => {
  const response = await worker.fetch(new Request("https://gateway.example.test/legacy"));
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /id="invite" type="password" autocomplete="off"/);
  assert.match(html, /id="credential" type="password" readonly autocomplete="off"/);
  assert.match(html, /id="secret"[^>]*\bhidden/);
  assert.match(html, /id="consent" type="checkbox" required>/);
  assert.match(html, /can read all messages in its room/);
  assert.match(html, /dedicated disposable room/);
  assert.match(response.headers.get("content-security-policy"), /script-src 'self'/);
  assert.equal((html.match(/<script /g) ?? []).length, 1);
  assert.match(html, /<script src="\/gateway-client.js" defer><\/script>/);
});

test("gateway UI issues one private request, recovers only on explicit retry and clears secrets", async () => {
  const f = await ui([new Error("synthetic network failure")]);
  f.elements.provision.onsubmit({ preventDefault() {} });
  await f.flush();
  assert.equal(f.requests.length, 1);
  assert.equal(f.elements.invite.value, "");
  assert.equal(f.elements.create.disabled, true);
  assert.equal(f.elements.retry.hidden, false);
  assert.equal(f.elements.secret.hidden, true);
  const first = JSON.parse(f.requests[0].init.body);
  assert.equal(/^[A-Za-z0-9_-]{43}$/.test(first.provisioningKey), true, "Synthetic recovery key is valid base64url.");
  assert.equal(first.invitationCode, "synthetic-nonfunctional-invitation");
  assert.equal(f.requests[0].init.credentials, "omit");
  assert.equal(f.requests[0].init.cache, "no-store");
  // A second submit cannot silently mint another identity while pending.
  f.elements.provision.onsubmit({ preventDefault() {} });
  await f.flush();
  assert.equal(f.requests.length, 1);
  await f.elements.retry.onclick();
  await f.flush();
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[0].init.body === f.requests[1].init.body, true, "Explicit retry preserves the private body (redacted).");
  assert.equal(f.elements.credential.value, "synthetic-nonfunctional-credential");
  assert.equal(f.elements.secret.hidden, false);
  await f.elements.copy.onclick();
  assert.equal(f.copied[0], "synthetic-nonfunctional-credential");
  f.listeners.pagehide();
  assert.equal(f.elements.credential.value, "");
  assert.equal(f.elements.secret.hidden, true);
  assert.equal(f.elements.retry.hidden, true);
});

test("gateway UI handles HTTP setup failures and expiry without automatic retransmission", async () => {
  const f = await ui([{ ok: false, body: { error: { message: "Synthetic limit" } } }]);
  f.elements.provision.onsubmit({ preventDefault() {} });
  await f.flush();
  assert.equal(f.requests.length, 1);
  assert.match(f.elements.result.textContent, /Retry the SAME attempt/);
  for (const timer of [...f.timers.values()]) timer();
  assert.equal(f.requests.length, 1);
  assert.equal(f.elements.retry.hidden, true);
  assert.equal(f.elements.create.disabled, false);
  assert.equal(f.elements.secret.hidden, true);
});

test("gateway UI revocation keeps the credential out of URL/body and clears the input", async () => {
  const f = await ui([{ body: { revoked: true, roomLeft: false } }]);
  f.elements["revoke-token"].value = "synthetic-nonfunctional-credential";
  await f.elements.revoke.onsubmit({ preventDefault() {} });
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].path, "/bridge/v1/session");
  assert.equal(f.requests[0].init.method, "DELETE");
  assert.equal(f.requests[0].init.headers.authorization, "Bearer synthetic-nonfunctional-credential");
  assert.equal(f.requests[0].init.body, undefined);
  assert.equal(f.elements["revoke-token"].value, "");
  assert.match(f.elements["revoke-result"].textContent, /owner can close/);
});
test("Link page offers public room creation and keeps both explicit consent choices off by default", async () => {
  const html = await (await worker.fetch(new Request("https://gateway.example.test/legacy"))).text();
  assert.match(html, /<title>Link ·/);
  assert.match(html, /No Codex plugin/);
  assert.match(html, /id="new-room"/);
  assert.match(html, /id="host-consent" type="checkbox" required>/);
  assert.match(html, /id="owner-secret"[^>]*hidden/);
  assert.match(html, /id="room-code" type="password" readonly autocomplete="off"/);
  assert.match(html, /id="owner-credential" type="password" readonly autocomplete="off"/);
  assert.equal(/id="(?:host-consent|consent)"[^>]*checked/.test(html), false);
  assert.match(html, /not end-to-end encrypted between agents/);
});

test("web room creation copies owner and invitation separately, clears on pagehide and needs no plugin", async () => {
  const f = await ui([{ body: {
    invitationCode: "synthetic-invitation", credential: "synthetic-owner-credential", roomExpiresAt: "synthetic room expiry",
  } }]);
  f.elements["new-room"].onsubmit({ preventDefault() {} });
  await f.flush();
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].path, "/bridge/v1/rooms");
  const body = JSON.parse(f.requests[0].init.body);
  assert.equal(body.displayName, "Synthetic UI host");
  assert.equal(body.consentToPlaintextGateway, true);
  assert.equal(Object.hasOwn(body, "ttlMinutes"), false);
  assert.equal(Object.hasOwn(body, "invitationCode"), false);
  assert.match(body.provisioningKey, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(f.elements["owner-secret"].hidden, false);
  await f.elements["copy-invite"].onclick();
  await f.elements["copy-owner"].onclick();
  assert.deepEqual(f.copied, ["synthetic-invitation", "synthetic-owner-credential"]);
  f.listeners.pagehide();
  assert.equal(f.elements["room-code"].value, "");
  assert.equal(f.elements["owner-credential"].value, "");
  assert.equal(f.elements["owner-secret"].hidden, true);
});

test("unknown room creation only retries the identical explicit request, not a new room", async () => {
  const f = await ui([new Error("synthetic outage"), { body: {
    invitationCode: "synthetic-invitation", credential: "synthetic-owner-credential", roomExpiresAt: "synthetic expiry",
  } }]);
  f.elements["new-room"].onsubmit({ preventDefault() {} });
  await f.flush();
  assert.equal(f.requests.length, 1);
  assert.equal(f.elements["host-retry"].hidden, false);
  assert.equal(f.elements.create.disabled, true);
  f.elements.provision.onsubmit({ preventDefault() {} });
  await f.flush();
  assert.equal(f.requests.length, 1, "A second form must not start another identity while setup is pending.");
  await f.elements["host-retry"].onclick();
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[0].init.body, f.requests[1].init.body);
  assert.equal(f.requests[0].path, f.requests[1].path);
  assert.equal(f.elements["owner-secret"].hidden, false);
});

test("unchecked owner or guest consent cannot submit even through a scripted form event", async () => {
  const f = await ui();
  f.elements["host-consent"].checked = false;
  f.elements.consent.checked = false;
  f.elements["new-room"].onsubmit({ preventDefault() {} });
  f.elements.provision.onsubmit({ preventDefault() {} });
  await f.flush();
  assert.equal(f.requests.length, 0);
  assert.match(f.elements["host-result"].textContent, /consent is required/);
});

test("public agent instructions include the guide but no displayed invitation or credential", async () => {
  const f = await ui();
  f.elements["room-code"].value = "synthetic-private-invitation";
  f.elements["owner-credential"].value = "synthetic-private-owner";
  f.elements.credential.value = "synthetic-private-guest";
  await f.elements["copy-instructions"].onclick();
  assert.match(f.copied[0], /https:\/\/gateway.example.test\/guide/);
  assert.match(f.copied[0], /Do not start autonomous loops/);
  assert.equal(f.copied[0].includes("synthetic-private"), false);
});

test("owner closure requires explicit checkbox and uses only the Authorization header", async () => {
  const f = await ui([{ body: { revoked: true, roomClosed: true } }]);
  f.elements["owner-token"].value = "synthetic-owner-credential";
  await f.elements["close-room"].onclick();
  assert.equal(f.requests.length, 0);
  f.elements["confirm-close"].checked = true;
  await f.elements["close-room"].onclick();
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].path, "/bridge/v1/room");
  assert.equal(f.requests[0].init.method, "DELETE");
  assert.equal(f.requests[0].init.headers.authorization, "Bearer synthetic-owner-credential");
  assert.equal(f.requests[0].init.body, undefined);
  assert.equal(f.elements["owner-token"].value, "");
  assert.equal(f.elements["confirm-close"].checked, false);
  assert.match(f.elements["manage-result"].textContent, /Room closed/);
});

test("owner invitation recovery stays private and is cleared from the page", async () => {
  const f = await ui([{ body: { invitationCode: "synthetic-recovered-invitation", roomExpiresAt: "synthetic expiry" } }]);
  f.elements["owner-token"].value = "synthetic-owner-credential";
  await f.elements.manage.onsubmit({ preventDefault() {} });
  assert.equal(f.requests[0].path, "/bridge/v1/invitation");
  assert.equal(f.requests[0].init.method, "GET");
  assert.equal(f.elements["owner-token"].value, "");
  assert.equal(f.elements["room-code"].value, "synthetic-recovered-invitation");
  await f.elements["clear-owner"].onclick();
  assert.equal(f.elements["room-code"].value, "");
  assert.equal(f.elements["owner-credential"].value, "");
});
