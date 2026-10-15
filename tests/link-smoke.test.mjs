import assert from "node:assert/strict";
import test from "node:test";
import { createRelayServer } from "../dev-relay/server.mjs";
import { smokeOptions, smokeLink } from "../scripts/smoke-link.mjs";

test("relay smoke test requires explicit approval and rejects unsafe or unknown startup inputs", () => {
  assert.throws(() => smokeOptions([]), (error) => error.code === "LIVE_TEST_CONFIRMATION_REQUIRED");
  assert.throws(() => smokeOptions(["--confirm-live-test", "--relay", "http://remote.example.test"]), (error) => error.code === "INVALID_RELAY");
  assert.throws(() => smokeOptions(["--confirm-live-test", "--invitation", "never-echo-this"]), (error) => error.code === "INVALID_ARGUMENTS" && !error.message.includes("never-echo-this"));
});

test("opt-in smoke exchanges harmless packets and closes only its own room without revealing an invitation", async (t) => {
  const relay = createRelayServer({ port: 0 });
  const address = await relay.listen();
  t.after(() => relay.close());
  const result = await smokeLink(smokeOptions(["--confirm-live-test", "--relay", `http://127.0.0.1:${address.port}`]));
  assert.deepEqual(result, { passed: true, checksPassed: true, memberLeft: true, roomClosed: true, hostedAssistantVerified: false });
  assert.equal(/cl2\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/.test(JSON.stringify(result)), false);
  assert.equal(relay.rooms.size, 0);
});
