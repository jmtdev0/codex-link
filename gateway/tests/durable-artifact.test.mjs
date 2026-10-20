import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { TestD1 } from "./support/d1.mjs";

test("the standalone deployment artifact serves a functional client and durable room API", async t => {
  const code = await readFile(new URL("../dist/server/index.js", import.meta.url), "utf8");
  const module = await import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
  const DB = new TestD1(), env = { DB, LINK_GATEWAY_MASTER_KEY: randomBytes(32).toString("base64url") }; t.after(() => DB.close());
  const wire = (url, init = {}) => module.default.fetch(new Request(url, { ...init, headers: { ...init.headers, "cf-connecting-ip": "artifact-qa" } }), env);
  const sdk = await wire("https://artifact.test/link-client.mjs");
  const { createLinkClient } = await import("data:text/javascript;base64," + Buffer.from(await sdk.text()).toString("base64"));
  const a = createLinkClient({ baseUrl: "https://artifact.test", consentToPlaintextGateway: true, fetch: wire });
  const room = await a.create(), b = createLinkClient({ baseUrl: "https://artifact.test", consentToPlaintextGateway: true, fetch: wire });
  await b.join(room.invitation); await a.send("Compiled artifact check", { requestId: "compiled-1" });
  assert.equal((await b.receive({ waitMs: 0 })).messages[0].text, "Compiled artifact check");
  assert.equal((await a.resume()).participantCount, 2);
  const schema = await (await wire("https://artifact.test/link-openapi.json")).json();
  assert.deepEqual(schema.paths["/send"].post.requestBody.content["application/json"].schema.required, ["text", "requestId"]);
  assert.equal(schema.paths["/receive"].post.requestBody.content["application/json"].schema.properties.waitMs.maximum, 25000);
  for (const path of ["/", "/legacy", "/guide", "/legacy-guide", "/rooms", "/favicon.svg", "/link-ui.mjs"]) assert.equal((await wire("https://artifact.test" + path)).status, 200, path);
  await a.close();
});
