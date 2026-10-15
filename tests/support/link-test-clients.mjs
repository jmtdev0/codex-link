import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { createSitesRelay } from "../../site/worker/index.js";

export function startJsonProcess(entry, relayUrl, { mcp = false } = {}) {
  const path = fileURLToPath(new URL(entry, import.meta.url));
  const child = spawn(process.execPath, mcp ? [path] : [path, "--relay", relayUrl], {
    env: { ...process.env, CODEX_LINK_RELAY_URL: relayUrl }, stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  let nextId = 1;
  child.stderr.resume();
  lines.on("line", (line) => {
    let value;
    try { value = JSON.parse(line); } catch { return; }
    const waiter = pending.get(value.id);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    pending.delete(value.id);
    waiter.resolve(value);
  });
  return {
    async request(method, params = {}) {
      const id = nextId++;
      const result = new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error("Local JSON test request timed out.")); }, 5_000);
        pending.set(id, { resolve, reject, timer });
      });
      child.stdin.write(`${JSON.stringify({ ...(mcp ? { jsonrpc: "2.0" } : {}), id, method, params })}\n`);
      return result;
    },
    async close() {
      child.stdin.end();
      if (child.exitCode === null) await once(child, "exit");
      lines.close();
    },
  };
}

export async function mountSitesRelay(db) {
  const worker = createSitesRelay({ cleanupIntervalMs: 0, waitPollMs: 5 });
  const requests = [];
  const server = createServer(async (incoming, outgoing) => {
    try {
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const headers = new Headers();
      for (const name of ["accept", "authorization", "content-type"]) {
        if (typeof incoming.headers[name] === "string") headers.set(name, incoming.headers[name]);
      }
      headers.set("cf-connecting-ip", "127.0.0.1");
      requests.push({ url: incoming.url, body: body.toString("utf8"), headers: Object.fromEntries(headers) });
      const response = await worker.fetch(new Request(`http://127.0.0.1${incoming.url}`, {
        method: incoming.method, headers, body: body.length ? body : undefined,
      }), { CODEX_LINK_RATE_LIMIT_KEY: "test-only-link-api-rate-limit-key", DB: db });
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch { outgoing.writeHead(500); outgoing.end(); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`, requests,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
