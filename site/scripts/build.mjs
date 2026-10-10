import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = resolve(projectRoot, "dist");
if (!distRoot.startsWith(`${projectRoot}${sep}`)) {
  throw new Error("The build output must stay inside the Site project.");
}

await rm(distRoot, { recursive: true, force: true });
await mkdir(resolve(distRoot, "server"), { recursive: true });
await mkdir(resolve(distRoot, ".openai"), { recursive: true });
await mkdir(resolve(distRoot, "migrations"), { recursive: true });
await copyFile(resolve(projectRoot, "worker/index.js"), resolve(distRoot, "server/index.js"));
await copyFile(resolve(projectRoot, ".openai/hosting.json"), resolve(distRoot, ".openai/hosting.json"));
for (const migration of await readdir(resolve(projectRoot, "migrations"))) {
  if (!migration.endsWith(".sql")) continue;
  await copyFile(resolve(projectRoot, "migrations", migration), resolve(distRoot, "migrations", migration));
}

console.log(`Built ${distRoot}`);
