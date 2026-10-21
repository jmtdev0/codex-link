import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { durableGuide } from "../../gateway/worker/link-pages.js";
import { PUBLIC_ORIGIN } from "../lib/config.mjs";

test("agent quick start supplies a minimal creation request without treating the guide as consent", async () => {
  for (const options of [{}, { agentSessionHelper: true }]) {
    const guide = await durableGuide(PUBLIC_ORIGIN, options).text();
    assert.ok(guide.includes("Create a Link room and show me its invitation: " + PUBLIC_ORIGIN + "/guide"));
    assert.ok(guide.includes("If they only share this guide without an action, ask one short question"));
    assert.ok(guide.includes("it is not human authorization"));
    assert.ok(guide.includes("this HTTPS gateway can read messages"));
    assert.ok(guide.includes("your own human's separate storage permission"));
    assert.ok(guide.indexOf("## Agent quick start") < guide.indexOf("## Connect as an invited participant"));
  }
});

test("creation uses one memory-only owner and exposes only the intended invitation fields", async () => {
  const guide = await durableGuide(PUBLIC_ORIGIN).text();
  const creator = guide.split("## Agent quick start")[1].split("## Hand over an invitation")[0];
  assert.ok(creator.includes("link.create({ name: 'My agent', ttlMinutes: 1440 })"));
  assert.ok(creator.includes("do not join your own invitation as a second participant"));
  assert.ok(creator.includes("SAME credential and original fields"));
  assert.ok(creator.includes("room.invitation, room.roomId and room.expiresAt"));
  assert.ok(creator.includes("Do NOT print room or room.credential"));
  assert.ok(creator.includes("kept in memory by default"));
  assert.ok(!creator.includes("saveSession:"));
});

test("listening distinguishes intermediate publication from final handover and repeats empty waits", async () => {
  const guide = await durableGuide(PUBLIC_ORIGIN).text();
  const listening = guide.split("## Hand over an invitation versus keep listening")[1].split("## Connect as an invited participant")[0];
  for (const expected of ["CREATE AND RETURN", "CREATE AND WAIT", "INTERMEDIATE message", "SAME active turn", "two explicit stages", "single five-second wait", "receive({waitMs:25000, confirmReceipt:false})", "NOT the listening window", "new messageIds only", "unprocessed message", "final answer ends this listening turn", "do not assert an unobserved platform limit"]) {
    assert.ok(listening.toLowerCase().includes(expected.toLowerCase()), expected);
  }
  assert.ok(listening.includes("TEST_END from the intended peer or ten minutes"));
  assert.ok(listening.includes("Do not close the room or revoke participants unless the human asks"));
});

test("Netlify publishes the same quick start and resolved waiting instructions without credentials", async () => {
  const published = await readFile(new URL("../public/link-guide.txt", import.meta.url), "utf8");
  const source = await durableGuide(PUBLIC_ORIGIN, { agentSessionHelper: true }).text();
  const section = guide => guide.split("## Agent quick start")[1].split("## Connect as an invited participant")[0];
  assert.equal(section(published), section(source));
  assert.ok(!/(?:lks2\.[A-Za-z0-9_-]{43}|link2\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43})/.test(published));
});
