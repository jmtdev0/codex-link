import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { Script } from "node:vm";
import test from "node:test";
import worker from "../gateway/worker/index.js";

async function ui(responses = []) {
  const script = await (await worker.fetch(new Request("https://gateway.example.test/gateway-client.js"))).text();
  const ids = ["credential", "secret", "copy", "forget", "provision", "create", "result", "retry", "invite", "name", "ttl", "consent", "revoke", "revoke-token", "revoke-result"];
  const elements = Object.fromEntries(ids.map(id => [id, { value: "", hidden: id === "secret" || id === "retry", disabled: false, checked: false, textContent: "" }]));
  Object.assign(elements.invite, { value: "synthetic-nonfunctional-invitation" });
  Object.assign(elements.name, { value: "Synthetic UI test" });
  Object.assign(elements.ttl, { value: "60" });
  Object.assign(elements.consent, { checked: true });
  const requests = [], copied = [], listeners = {}, timers = new Map();
  let nextTimer = 1;
  const sandbox = {
    document: { getElementById: id => elements[id] }, window: { addEventListener: (name, handler) => { listeners[name] = handler; } },
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
  const response = await worker.fetch(new Request("https://gateway.example.test/"));
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /id="invite" type="password" autocomplete="off"/);
  assert.match(html, /id="credential" type="password" readonly autocomplete="off"/);
  assert.match(html, /id="secret" hidden/);
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
