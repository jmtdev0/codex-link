import { copyFile, cp, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
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
await copyFile(resolve(projectRoot, "worker/index.js"), resolve(distRoot, "server/index.js"));
const hostingPath = resolve(projectRoot, ".openai/hosting.json");
const exampleHostingPath = resolve(projectRoot, ".openai/hosting.json.example");
await copyFile(
  existsSync(hostingPath) ? hostingPath : exampleHostingPath,
  resolve(distRoot, ".openai/hosting.json"),
);
await cp(resolve(projectRoot, "drizzle"), resolve(distRoot, ".openai/drizzle"), { recursive: true });

console.log(`Built ${distRoot}`);
