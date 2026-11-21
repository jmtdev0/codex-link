import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { signEdgeRequest, verifyEdgeRequest, readBoundedBody, ATTESTATION_HEADER } from "../lib/attestation.mjs";
import { createNeonService } from "../lib/service.mjs";
import { proxyLink } from "../../netlify/edge-functions/link-proxy.mjs";
import { PUBLIC_ORIGIN, SITE_ID } from "../../netlify/lib/config.mjs";

const secret = randomBytes(32).toString("base64url");
const options = { secret, siteId: SITE_ID, origin: PUBLIC_ORIGIN, ip: "192.0.2.10", now: 1800000000000 };
const body = new TextEncoder().encode('{"waitMs":25000}');
const makeRequest = (overrides = {}) => new Request(PUBLIC_ORIGIN + "/link/v1/receive", {
  method: "POST", headers: { authorization: "Bearer synthetic", "content-type": "application/json" }, body, ...overrides,
});
async function signed(request = makeRequest(), bytes = body, opts = options) {
  const headers = new Headers(request.headers);
  headers.set(ATTESTATION_HEADER, await signEdgeRequest(request, bytes, opts));
  return new Request(request, { headers });
}

test("edge proof binds actual IP, canonical site and complete request", async () => {
  const request = await signed();
  assert.deepEqual(await verifyEdgeRequest(request, body, options), { ip: options.ip, origin: PUBLIC_ORIGIN });
  const headers = new Headers(request.headers); headers.set("x-forwarded-for", "203.0.113.200");
  assert.equal((await verifyEdgeRequest(new Request(request, { headers }), body, options)).ip, options.ip);
});

test("forgeries, changed credentials, cookies, origins, bodies, paths and methods fail", async () => {
  const request = await signed();
  for (const [name, value] of [["authorization", "Bearer different"], ["cookie", "forged"], ["origin", "https://evil.example"], ["sec-fetch-site", "cross-site"], ["content-type", "text/plain"]]) {
    const headers = new Headers(request.headers); headers.set(name, value);
    assert.equal(await verifyEdgeRequest(new Request(request.url, { method: request.method, headers, body }), body, options), null);
  }
  assert.equal(await verifyEdgeRequest(request, new TextEncoder().encode("different"), options), null);
  assert.equal(await verifyEdgeRequest(new Request(PUBLIC_ORIGIN + "/link/v1/send", { method: "POST", headers: request.headers, body }), body, options), null);
  assert.equal(await verifyEdgeRequest(new Request(request.url, { method: "DELETE", headers: request.headers, body }), body, options), null);
  assert.equal(await verifyEdgeRequest(request, body, { ...options, secret: randomBytes(32).toString("base64url") }), null);
  assert.equal(await verifyEdgeRequest(request, body, { ...options, siteId: "other-site" }), null);
});

test("proofs expire and missing or malformed proofs fail closed", async () => {
  const request = await signed();
  assert.equal(await verifyEdgeRequest(request, body, { ...options, now: options.now + 60001 }), null);
  assert.equal(await verifyEdgeRequest(request, body, { ...options, now: options.now - 5001 }), null);
  for (const proof of ["", "A.B.C", "bad.value", "A".repeat(2200)]) {
    const headers = new Headers(request.headers); headers.set(ATTESTATION_HEADER, proof);
    assert.equal(await verifyEdgeRequest(new Request(request.url, { method: request.method, headers, body }), body, options), null);
  }
});

test("request bodies are bounded before forwarding", async () => {
  await assert.rejects(readBoundedBody(makeRequest({ body: "x".repeat(16385) })), RangeError);
  assert.equal((await readBoundedBody(makeRequest())).byteLength, body.byteLength);
});

test("native Neon origin rejects untrusted traffic without opening Postgres", async () => {
  let opened = 0;
  const handler = createNeonService({ getPool() { opened++; }, masterKey: () => secret, proxyKey: () => secret, now: () => options.now });
  assert.equal((await handler(new Request("https://native.example/link/v1/info"))).status, 401);
  const unauthenticated = makeRequest({ headers: { [ATTESTATION_HEADER]: "forged", "content-type": "application/json" } });
  assert.equal((await handler(unauthenticated)).status, 401);
  assert.equal(unauthenticated.bodyUsed, false, "reject invalid proof before reading the body");
  const info = new Request(PUBLIC_ORIGIN + "/link/v1/info");
  const trusted = await signed(info, new Uint8Array());
  const response = await handler(trusted), data = await response.json();
  assert.equal(response.status, 200); assert.equal(data.execution, "neon-functions");
  assert.equal(data.hosting, "netlify", "preserve existing hosting metadata for older clients");
  assert.equal(data.maxMessages, 2000); assert.equal(data.maxTtlMinutes, 20160); assert.equal(data.waitMode, "client");
  assert.equal(opened, 0);
});

test("edge forwards trusted proof, existing auth/cookie and Set-Cookie without caching", async () => {
  const upstream = "https://br-synthetic-linkapi.compute.cell.us-east-2.aws.neon.tech";
  const environment = { get: name => ({ LINK_PROXY_KEY: secret, LINK_NEON_API_ORIGIN: upstream })[name] };
  const request = makeRequest({ headers: { authorization: "Bearer synthetic", cookie: "__Host-link-session-v2=synthetic", "content-type": "application/json", [ATTESTATION_HEADER]: "caller-forgery", "x-secret": "caller-value" } });
  const response = await proxyLink(request, { site: { id: SITE_ID }, ip: options.ip }, { environment,
    async fetcher(url, init) {
      assert.equal(url.origin, upstream); assert.equal(url.pathname, "/link/v1/receive");
      assert.equal(init.headers.get("x-secret"), null); assert.equal(init.redirect, "manual");
      assert.ok(await verifyEdgeRequest(new Request(url, init), init.body, { ...options, now: Date.now() }));
      return new Response("{}", { headers: { "cache-control": "public", "set-cookie": "__Host-link-session-v2=synthetic; Path=/; HttpOnly; Secure; SameSite=Strict" } });
    },
  });
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  assert.ok(response.headers.get("set-cookie").includes("HttpOnly"));
  assert.equal(response.headers.get(ATTESTATION_HEADER), null);
});

test("edge fails closed for wrong public origin, site, upstream or missing trusted IP", async () => {
  const environment = { get: name => ({ LINK_PROXY_KEY: secret, LINK_NEON_API_ORIGIN: "https://attacker.example" })[name] };
  let fetched = false;
  const settings = { environment, fetcher() { fetched = true; } };
  assert.equal((await proxyLink(new Request("https://wrong.example/link/v1/info"), { site: { id: SITE_ID }, ip: options.ip }, settings)).status, 421);
  assert.equal((await proxyLink(makeRequest(), { site: { id: SITE_ID }, ip: options.ip }, settings)).status, 503);
  assert.equal(fetched, false);
});

test("edge never follows upstream redirects carrying participant credentials", async () => {
  const environment = { get: name => ({ LINK_PROXY_KEY: secret, LINK_NEON_API_ORIGIN: "https://br-synthetic-linkapi.compute.cell.us-east-2.aws.neon.tech" })[name] };
  const response = await proxyLink(makeRequest(), { site: { id: SITE_ID }, ip: options.ip }, { environment, fetcher: async () => new Response(null, { status: 307, headers: { location: "https://attacker.example" } }) });
  assert.equal(response.status, 502); assert.equal(response.headers.get("location"), null);
});
