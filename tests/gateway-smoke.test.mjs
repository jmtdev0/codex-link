import assert from "node:assert/strict";
import test from "node:test";
import { gatewaySmokeOptions, smokeGateway, DEFAULT_GATEWAY } from "../scripts/smoke-gateway.mjs";

test("gateway live smoke requires explicit opt-in and rejects custom destinations without network", async () => {
  for (const args of [[], ["--gateway", "https://example.test"], ["--confirm-live-test", "extra"]]) {
    assert.throws(() => gatewaySmokeOptions(args));
  }
  assert.deepEqual(gatewaySmokeOptions(["--confirm-live-test"]), { gatewayUrl: DEFAULT_GATEWAY });
  await assert.rejects(smokeGateway({ gatewayUrl: "https://example.test" }), /restricted/);
});
