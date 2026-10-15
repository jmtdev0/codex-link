import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = resolve(root, "dist");
if (dist !== resolve(root, "dist") || !dist.startsWith(resolve(root) + "/") && !dist.startsWith(resolve(root) + "\\")) {
  throw new Error("Unexpected build target.");
}
const manifestPath = resolve(root, ".openai/hosting.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (!manifest.project_id || manifest.d1 !== "DB" || manifest.static) throw new Error("A registered Worker Site with DB is required.");
await rm(dist, { recursive: true, force: true });
await mkdir(resolve(dist, "server"), { recursive: true });
await mkdir(resolve(dist, ".openai"), { recursive: true });
await cp(resolve(root, "worker/index.js"), resolve(dist, "server/index.js"));
await cp(manifestPath, resolve(dist, ".openai/hosting.json"));
await cp(resolve(root, "drizzle"), resolve(dist, ".openai/drizzle"), { recursive: true });
console.log("Built the standalone gateway Worker and schema-only D1 migration.");
