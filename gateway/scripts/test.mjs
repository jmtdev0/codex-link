import { spawnSync } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Test a clean source copy. Never read/copy a developer's hosting identity,
// environment files, Git metadata, local artifacts, credentials or room data.
const root = fileURLToPath(new URL("../", import.meta.url));
const sourceFiles = [
  "package.json",
  "worker/index.js", "worker/link-v2.js", "worker/link-client.js", "worker/link-pages.js",
  "scripts/build.mjs", "scripts/validate-artifact.mjs", "scripts/preview.mjs", "scripts/smoke-durable.mjs",
  "drizzle/0001_gateway.sql", "drizzle/0002_private_room_history.sql", "drizzle/0003_durable_link.sql",
  "drizzle/meta/_journal.json",
  "tests/durable-artifact.test.mjs", "tests/durable-client.test.mjs", "tests/durable-http.test.mjs",
  "tests/durable.test.mjs", "tests/favicon.test.mjs", "tests/history.test.mjs",
  "tests/support/client-once.mjs", "tests/support/d1.mjs",
];
const temporaryRoot = resolve(tmpdir());
const directory = await mkdtemp(join(temporaryRoot, "link-public-gateway-test-"));
try {
  for (const name of sourceFiles) {
    const source = join(root, name), destination = join(directory, name);
    const metadata = await lstat(source);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("Expected an ordinary source file: " + name);
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination);
  }
  await mkdir(join(directory, ".openai"));
  await writeFile(join(directory, ".openai", "hosting.json"), JSON.stringify({
    project_id: "synthetic-local-test-only", d1: "DB", r2: null,
  }) + "\n");
  const tests = (await readdir(join(directory, "tests")))
    .filter(name => name.endsWith(".test.mjs")).sort().map(name => "tests/" + name);
  for (const args of [["scripts/build.mjs"], ["scripts/validate-artifact.mjs"], ["--test", ...tests]]) {
    const result = spawnSync(process.execPath, args, { cwd: directory, stdio: "inherit", windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      process.exitCode = result.status ?? 1;
      break;
    }
  }
} finally {
  // Only remove the unique directory returned by mkdtemp, never a caller path.
  if (resolve(directory).startsWith(temporaryRoot + (process.platform === "win32" ? "\\" : "/")) &&
      directory.startsWith(join(temporaryRoot, "link-public-gateway-test-"))) {
    await rm(directory, { recursive: true, force: true });
  }
}
