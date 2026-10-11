import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const workerPath = resolve(projectRoot, "dist/server/index.js");
const manifestPath = resolve(projectRoot, "dist/.openai/hosting.json");
const migrationPath = resolve(projectRoot, "dist/.openai/drizzle/0001_codex_link_relay.sql");
const capabilityMigrationPath = resolve(projectRoot, "dist/.openai/drizzle/0002_room_capabilities_and_rate_limits.sql");
const journalPath = resolve(projectRoot, "dist/.openai/drizzle/meta/_journal.json");

const [source, manifest, migration, capabilityMigration, journalText] = await Promise.all([
  readFile(workerPath, "utf8"),
  readFile(manifestPath, "utf8"),
  readFile(migrationPath, "utf8"),
  readFile(capabilityMigrationPath, "utf8"),
  readFile(journalPath, "utf8"),
]);
const hosting = JSON.parse(manifest);
const journal = JSON.parse(journalText);
assert.equal(hosting.d1, "DB", "the Site must have the DB D1 binding");
assert.equal(journal.dialect, "sqlite", "the migration journal must use the SQLite dialect");
assert.equal(journal.entries?.[0]?.tag, "0001_codex_link_relay", "the migration journal must reference the D1 migration");
assert.equal(journal.entries?.[1]?.tag, "0002_room_capabilities_and_rate_limits", "the migration journal must include room authorization and request limits");
assert.ok(migration.includes("CREATE TABLE codex_link_rooms"), "the artifact must include the relay room schema");
assert.ok(capabilityMigration.includes("capability_hash"), "the artifact must persist only a room-capability hash");
assert.ok(capabilityMigration.includes("codex_link_rate_limits"), "the artifact must include rate-limit storage");

const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const workerModule = await import(moduleUrl);
assert.equal(
  typeof workerModule.default?.fetch,
  "function",
  `${pathToFileURL(workerPath)} must export default.fetch`,
);

console.log("Artifact is valid ESM and exports default.fetch");
