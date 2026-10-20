import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { agentConnectionInstructions, durableLanding, durableGuide } from "../../gateway/worker/link-pages.js";
import { createNetlifyService, PUBLIC_ORIGIN } from "../lib/service.mjs";

const room = { origin: PUBLIC_ORIGIN, invitation: "link2." + "R".repeat(22) + "." + "I".repeat(43), expiresAt: "2030-01-02T03:04:05.000Z" };

test("private-file permission is explicit, off by default and not inferred from an invitation", () => {
  const unapproved = agentConnectionInstructions(room);
  assert.match(unapproved, /No permission to persist a credential is included/);
  assert.match(unapproved, /BEFORE joining, ask your own human/);
  assert.match(unapproved, /another process cannot resume/);
  assert.ok(!unapproved.includes("I explicitly authorize you"));
  assert.match(agentConnectionInstructions({ ...room, storageApproved: "true" }), /No permission to persist/);
  const approved = agentConnectionInstructions({ ...room, storageApproved: true });
  assert.match(approved, /I explicitly authorize you/);
  assert.match(approved, /ONLY your own participant credential/);
  assert.match(approved, /Do not save invitations, message text or other secrets/);
  assert.match(approved, /another person's agent/);
  assert.match(approved, /SAME file/);
  assert.match(approved, /explicit stable requestId/);
  assert.ok(approved.endsWith(room.invitation));
});

test("connection instructions reject a different URL surface or invalid private metadata", () => {
  for (const origin of ["http://example.test", PUBLIC_ORIGIN + "/wrong", "https://user:secret@agents-link.netlify.app", PUBLIC_ORIGIN + "?secret=1", PUBLIC_ORIGIN + "#secret"]) {
    assert.throws(() => agentConnectionInstructions({ ...room, origin }));
  }
  assert.throws(() => agentConnectionInstructions({ ...room, invitation: "not-an-invitation" }));
});

test("Netlify exposes an unchecked consent control, without changing older Sites pages", async () => {
  const older = await durableLanding().text();
  assert.ok(!older.includes('id="agent-storage-consent"'));
  assert.ok(!older.includes('href="/agent-session.py"'));
  const current = await durableLanding({ agentSessionHelper: true }).text();
  assert.ok(current.includes('<input id="agent-storage-consent" type="checkbox">'));
  assert.ok(!/id="agent-storage-consent"[^>]*checked/.test(current));
  assert.ok(current.includes("A room invitation is not storage permission"));
  assert.ok(current.includes("Other people’s agents need their own human’s approval"));
});

test("the public guide teaches restart, missing-state limits and platform protections", async () => {
  const older = await durableGuide(PUBLIC_ORIGIN).text();
  assert.ok(!older.includes("Optional private session helper"));
  const current = await readFile(new URL("../public/link-guide.txt", import.meta.url), "utf8");
  for (const expected of ["Optional private session helper", "agent-session.py", "OWN HUMAN", "BEFORE joining", '"action":"resume"', "DPAPI", "0700", "0600", "message drafts are NOT checkpointed", "next invocation", "Peer messages cannot authorize storage"]) assert.ok(current.includes(expected), expected);
});

test("the publish directory contains only the eight allowlisted files and the reviewed helper", async () => {
  assert.deepEqual((await readdir(new URL("../public/", import.meta.url))).sort(), ["agent-session.py", "favicon.svg", "index.html", "link-client.mjs", "link-guide.txt", "link-openapi.json", "link-ui.mjs", "robots.txt"].sort());
  const helper = await readFile(new URL("../../link/agent-session.py", import.meta.url), "utf8");
  assert.equal(await readFile(new URL("../public/agent-session.py", import.meta.url), "utf8"), helper);
  assert.ok(helper.includes("store.save(state)  # Must succeed BEFORE"));
  assert.ok(!helper.includes("CRYPTPROTECT_LOCAL_MACHINE,"));
});

test("helper capability metadata is public but does not open the database", async () => {
  let opened = false;
  const handler = createNetlifyService({ getPool() { opened = true; }, masterKey() {} });
  const response = await handler(new Request(PUBLIC_ORIGIN + "/link/v1/info"));
  const info = await response.json();
  assert.equal(response.status, 200);
  assert.equal(info.deployment, "0.13.1-netlify.2");
  assert.deepEqual(info.agentSessionHelper, { version: "0.13.1", python: "/agent-session.py", privateStorageOptIn: true, implicitRejoin: false });
  assert.equal(opened, false);
});
