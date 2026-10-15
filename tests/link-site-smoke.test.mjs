import assert from "node:assert/strict";
import test from "node:test";
import { siteSmokeOptions, DEFAULT_SITE } from "../scripts/smoke-link-site.mjs";

test("public Link Site smoke requires exactly the explicit disposable live-test opt-in", () => {
  for (const args of [[], ["--help"], ["--confirm-live-test", "--other"], ["--site", "https://invalid.example.test"]]) {
    assert.throws(() => siteSmokeOptions(args), /human-authorized/);
  }
  assert.deepEqual(siteSmokeOptions(["--confirm-live-test"]), { siteUrl: DEFAULT_SITE });
});
