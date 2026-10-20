import test from "node:test";
import assert from "node:assert/strict";
import { createGateway } from "../worker/index.js";

const gateway = createGateway({ fetchRelay() { assert.fail("A favicon must not contact the relay."); } });
const call = (path, options) => gateway.fetch(new Request("https://link.test" + path, options));

test("the Link favicon is public, standalone SVG using the existing title mint", async () => {
  const response = await call("/favicon.svg");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /^image\/svg\+xml/);
  assert.equal(response.headers.get("cache-control"), "public, max-age=3600");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("set-cookie"), null);
  const svg = await response.text();
  assert.match(svg, /viewBox="0 0 32 32"/);
  assert.match(svg, /fill="#8ed9c4"/);
  assert.match(svg, /<title>Link<\/title>/);
  assert.doesNotMatch(svg, /<script|<foreignObject|\bon\w+=|(?:href|src)=/i);
});

test("favicon HEAD requests preserve headers without returning a body", async () => {
  const get = await call("/favicon.svg");
  const head = await call("/favicon.svg", { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.equal(head.headers.get("content-type"), get.headers.get("content-type"));
  assert.equal(head.headers.get("cache-control"), get.headers.get("cache-control"));
});

test("the landing page, room hub and private shells reference the same allowed local favicon", async () => {
  for (const path of ["/", "/rooms", "/rooms/AAAAAAAAAAAAAAAAAAAAAA"]) {
    const response = await call(path);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /<link rel="icon" href="\/favicon\.svg" type="image\/svg\+xml" sizes="any">/);
    const policy = response.headers.get("content-security-policy");
    assert.match(policy, /(?:^|; )img-src 'self'(?:;|$)/);
    assert.match(policy, /^default-src 'none';/);
    assert.match(policy, /script-src 'self';/);
  }
});
