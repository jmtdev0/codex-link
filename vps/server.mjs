// Self-hosted Link server: serves the public files and the /link/v1 API from a
// single Node process. It listens on localhost only; nginx terminates HTTPS,
// rate-limits and passes the client address in X-Real-IP.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createNetlifyService } from "../netlify/lib/service.mjs";
import { getLocalPool } from "./lib/database.mjs";
import { publicOrigin, listenPort, VERSION, DEPLOYMENT } from "./lib/config.mjs";

const ORIGIN = publicOrigin();
const PORT = listenPort();
const MAX_BODY = 64 * 1024;

const service = createNetlifyService({
  getPool: getLocalPool,
  origin: ORIGIN,
  initializeSchema: true,
  serviceOptions: { cleanupOnRequest: true },
  masterKey: () => process.env.LINK_GATEWAY_MASTER_KEY,
  onError: diagnostic => console.error("Link storage diagnostic", JSON.stringify(diagnostic)),
  deploymentInfo: {
    version: VERSION, hosting: "self-hosted", storage: "postgres", databaseProvider: "local", deployment: DEPLOYMENT,
    agentSessionHelper: { version: VERSION, python: "/agent-session.py", privateStorageOptIn: true, implicitRejoin: false },
  },
});

const SECURITY_HEADERS = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "content-security-policy": "default-src 'none'; img-src 'self'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};

// Only these generated files are ever served from disk.
const PUBLIC_FILES = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/index.html": ["index.html", "text/html; charset=utf-8"],
  "/guide": ["link-guide.txt", "text/plain; charset=utf-8"],
  "/link-guide": ["link-guide.txt", "text/plain; charset=utf-8"],
  "/link-guide.txt": ["link-guide.txt", "text/plain; charset=utf-8"],
  "/link-openapi.json": ["link-openapi.json", "application/json; charset=utf-8"],
  "/link-client.mjs": ["link-client.mjs", "application/javascript; charset=utf-8"],
  "/link-ui.mjs": ["link-ui.mjs", "application/javascript; charset=utf-8"],
  "/agent-session.py": ["agent-session.py", "text/plain; charset=utf-8"],
  "/favicon.svg": ["favicon.svg", "image/svg+xml"],
  "/robots.txt": ["robots.txt", "text/plain; charset=utf-8"],
};

async function serveStatic(pathname, res) {
  const entry = PUBLIC_FILES[pathname];
  if (!entry) {
    res.writeHead(404, { ...SECURITY_HEADERS, "content-type": "text/plain; charset=utf-8" });
    return res.end("Not found");
  }
  const body = await readFile(new URL("./public/" + entry[0], import.meta.url));
  const extra = entry[0] === "agent-session.py" ? { "content-disposition": "attachment; filename=agent-session.py" } : {};
  res.writeHead(200, { ...SECURITY_HEADERS, "content-type": entry[1], ...extra });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", chunk => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error("Body too large"), { status: 413 })); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// The proxy is the only trusted source of the client address.
function clientAddress(req) {
  const peer = req.socket.remoteAddress;
  if (peer !== "127.0.0.1" && peer !== "::1" && peer !== "::ffff:127.0.0.1") return undefined;
  const ip = req.headers["x-real-ip"];
  return typeof ip === "string" && ip.length <= 128 ? ip : undefined;
}

async function handleApi(req, res, url) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(name, value);
    else if (Array.isArray(value)) for (const v of value) headers.append(name, v);
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  const body = hasBody ? await readBody(req) : undefined;
  const request = new Request(ORIGIN + url.pathname + url.search, { method: req.method, headers, body });
  const response = await service(request, { ip: clientAddress(req) });
  const out = {};
  response.headers.forEach((value, name) => { if (name !== "set-cookie") out[name] = value; });
  const cookies = response.headers.getSetCookie();
  if (cookies.length) out["set-cookie"] = cookies;
  res.writeHead(response.status, { ...SECURITY_HEADERS, ...out });
  res.end(Buffer.from(await response.arrayBuffer()));
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, ORIGIN);
    if (url.pathname.startsWith("/link/v1/")) return await handleApi(req, res, url);
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { ...SECURITY_HEADERS, allow: "GET, HEAD" });
      return res.end();
    }
    return await serveStatic(url.pathname, res);
  } catch (error) {
    // Never log raw errors: they can contain conversation content.
    const status = error?.status === 413 ? 413 : 500;
    console.error("Link request failed", status);
    if (!res.headersSent) res.writeHead(status, { ...SECURITY_HEADERS, "content-type": "application/json" });
    res.end(JSON.stringify({ error: { code: status === 413 ? "BODY_LIMIT" : "LINK_UNAVAILABLE", message: "Operation is unconfirmed. Keep the same private credential and requestId." } }));
  }
});
server.requestTimeout = 40000;
server.headersTimeout = 15000;
server.listen(PORT, "127.0.0.1", () => console.log(`Link ${DEPLOYMENT} listening on 127.0.0.1:${PORT} for ${ORIGIN}`));
