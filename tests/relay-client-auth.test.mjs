import assert from "node:assert/strict";
import test from "node:test";
import { createRoom } from "../plugin/src/relay-client.mjs";

function saveEnvironment(keys) {
  return new Map(keys.map((key) => [key, process.env[key]]));
}

function restoreEnvironment(previous) {
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test("private Site service token is sent only to the exact configured Site origin", async () => {
  const envKeys = ["CODEX_LINK_ACCESS_TOKEN", "CODEX_LINK_SITES_BYPASS_TOKEN", "CODEX_LINK_SITES_ALLOWED_ORIGIN"];
  const previous = saveEnvironment(envKeys);
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: new URL(url), headers: new Headers(init.headers), redirect: init.redirect });
    return new Response(JSON.stringify({ expiresAt: "2030-01-01T00:00:00.000Z" }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    process.env.CODEX_LINK_ACCESS_TOKEN = "test-app-access-token";
    process.env.CODEX_LINK_SITES_BYPASS_TOKEN = "test-sites-bypass-token";
    process.env.CODEX_LINK_SITES_ALLOWED_ORIGIN = "https://relay.test.chatgpt.site";

    await createRoom("https://relay.test.chatgpt.site", "a".repeat(22), "b".repeat(22));
    await createRoom("https://relay.example.test", "c".repeat(22), "d".repeat(22));
    await assert.rejects(
      createRoom("https://other.chatgpt.site", "e".repeat(22), "f".repeat(22)),
      /exact configured relay origin/i,
    );

    assert.equal(calls[0].headers.get("authorization"), "Bearer test-app-access-token");
    assert.equal(calls[0].headers.get("oai-sites-authorization"), "Bearer test-sites-bypass-token");
    assert.equal(calls[0].redirect, "error");
    assert.equal(calls[1].headers.get("authorization"), "Bearer test-app-access-token");
    assert.equal(calls[1].headers.has("oai-sites-authorization"), false);
    assert.equal(calls[1].redirect, "error");
    assert.equal(calls.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnvironment(previous);
  }
});
