// Loopback-only QA adapter. No production credentials or database are used.
import http from "node:http";
import { randomBytes } from "node:crypto";
import { createGateway } from "../worker/index.js";
import { TestD1, memoryRelay } from "../tests/support/d1.mjs";

const DB = new TestD1();
const env = { DB, LINK_GATEWAY_MASTER_KEY: randomBytes(32).toString("base64url") };
const gateway = createGateway({ fetchRelay: memoryRelay() });
let authority = "";
const server = http.createServer(async (incoming, outgoing) => {
  if (incoming.headers.host !== authority) { outgoing.writeHead(400).end(); return; }
  try {
    const chunks = []; let bytes = 0;
    for await (const chunk of incoming) {
      bytes += chunk.length;
      if (bytes > 140 * 1024) { outgoing.writeHead(413).end(); return; }
      chunks.push(chunk);
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    headers.set("cf-connecting-ip", "local-preview");
    if (headers.get("origin") === "http://" + authority) headers.set("origin", "https://" + authority);
    if (headers.has("cookie")) headers.set("cookie", headers.get("cookie").replaceAll("link-preview-history-", "__Host-link-history-").replaceAll("link-preview-session-v2", "__Host-link-session-v2"));
    const body = Buffer.concat(chunks);
    const cancellation = new AbortController(); outgoing.once("close", () => cancellation.abort());
    const request = new Request("https://" + authority + incoming.url, {
      method: incoming.method, headers, signal: cancellation.signal, ...(body.length ? { body } : {}),
    });
    const response = await gateway.fetch(request, env);
    const responseHeaders = {};
    for (const [name, value] of response.headers) if (name !== "set-cookie") responseHeaders[name] = value;
    // Only this development adapter translates cookie names/flags for plain
    // loopback HTTP. The deployed Worker keeps __Host-, Secure and HttpOnly.
    const cookies = response.headers.getSetCookie().map(value => value.replace("__Host-link-history-", "link-preview-history-").replace("__Host-link-session-v2", "link-preview-session-v2").replace("; Secure;", ";"));
    if (cookies.length) responseHeaders["set-cookie"] = cookies;
    outgoing.writeHead(response.status, responseHeaders);
    const responseBytes = Buffer.from(await response.arrayBuffer());
    if (response.headers.get("content-type")?.startsWith("application/json")) {
      const result = JSON.parse(responseBytes.toString("utf8"));
      if (result.apiBase === "https://" + authority + "/link/v1") result.apiBase = "http://" + authority + "/link/v1";
      outgoing.end(JSON.stringify(result));
    } else outgoing.end(responseBytes);
  } catch { outgoing.writeHead(500, { "content-type": "text/plain" }); outgoing.end("Local preview failed."); }
});
server.listen(0, "127.0.0.1", () => {
  authority = "127.0.0.1:" + server.address().port;
  console.log("Local: http://" + authority + "/");
});
for (const event of ["SIGINT", "SIGTERM"]) process.once(event, () => server.close(() => { DB.close(); process.exit(0); }));
