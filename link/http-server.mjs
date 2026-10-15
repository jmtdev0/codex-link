import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { LinkClient } from "./client.mjs";
import { LinkError, publicError } from "./errors.mjs";
import { dispatch } from "./dispatch.mjs";
import { parseArguments } from "./arguments.mjs";

const MAX_BODY_BYTES = 64 * 1024;

function json(response, status, body) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8", "cache-control": "no-store",
    "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
  });
  response.end(JSON.stringify(body));
}

async function readBody(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] ?? "")) {
    throw new LinkError("CONTENT_TYPE_REQUIRED", "Requests with a body require application/json.", 415);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new LinkError("INPUT_TOO_LARGE", "Local API request bodies are limited to 64 KiB.", 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new LinkError("INVALID_JSON", "The request body must be JSON."); }
}

export function createLinkHttpServer({ relayUrl, port = 0, host = "127.0.0.1" } = {}) {
  if (host !== "127.0.0.1") throw new LinkError("INVALID_BIND", "The plaintext client API may bind only to 127.0.0.1.");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new LinkError("INVALID_PORT", "port must be an integer from 0 to 65535.");
  const client = new LinkClient({ relayUrl });
  const token = randomBytes(32).toString("base64url");
  const authorization = Buffer.from(`Bearer ${token}`);

  const server = createServer(async (request, response) => {
    try {
      // No CORS, cookies, browser Origin, configurable per-request relay, or
      // public bind. Host validation also blocks DNS-rebinding hostnames.
      const address = server.address();
      if (request.headers.origin !== undefined || request.headers.host !== `127.0.0.1:${address.port}`) {
        throw new LinkError("LOCAL_CLIENT_ONLY", "This endpoint accepts only authorized local non-browser clients.", 403);
      }
      const supplied = Buffer.from(typeof request.headers.authorization === "string" ? request.headers.authorization : "");
      if (supplied.length !== authorization.length || !timingSafeEqual(supplied, authorization)) {
        throw new LinkError("UNAUTHORIZED", "A local-process bearer token is required.", 401);
      }
      if (request.url.includes("?") || request.url.includes("#")) throw new LinkError("INVALID_URL", "Queries and fragments are not accepted. Supply inputs in a JSON body.");
      let method;
      let params = {};
      if (["/link/v1", "/link/v1/"].includes(request.url) && request.method === "GET") method = "info";
      else if (request.url === "/link/v1/rooms" && request.method === "POST") {
        method = "create";
        params = await readBody(request);
      } else if (request.url === "/link/v1/join" && request.method === "POST") {
        method = "join";
        params = await readBody(request);
      } else {
        const match = request.url.match(/^\/link\/v1\/sessions\/([A-Za-z0-9_-]{22})(?:\/(messages|receive|ack))?$/);
        if (match) {
          if (!match[2] && request.method === "GET") method = "status";
          else if (!match[2] && request.method === "DELETE") method = "disconnect";
          else if (match[2] && request.method === "POST") {
            method = match[2] === "messages" ? "send" : match[2];
            params = await readBody(request);
            if (!params || typeof params !== "object" || Array.isArray(params)) {
              throw new LinkError("INVALID_INPUT", "The request body must be a JSON object.");
            }
            // A JSON sessionId may never override the signed route's session.
            if (params && typeof params === "object" && Object.hasOwn(params, "sessionId")) {
              throw new LinkError("INVALID_INPUT", "Supply the session ID only in the route.");
            }
          }
          params = { ...params, sessionId: match[1] };
        }
      }
      if (!method) throw new LinkError("NOT_FOUND", "Unknown Link API route or HTTP method.", 404);
      const result = await dispatch(client, method, params);
      json(response, 200, { result });
    } catch (error) {
      if (!response.headersSent && !response.destroyed) json(response, error instanceof LinkError ? error.status : 500, { error: publicError(error) });
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  server.keepAliveTimeout = 1_000;
  server.maxHeadersCount = 40;

  return {
    async listen() {
      const address = await new Promise((resolveAddress, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.removeListener("error", reject);
          resolveAddress(server.address());
        });
      });
      return { baseUrl: `http://127.0.0.1:${address.port}/link/v1`, bearerToken: token };
    },
    async close() {
      await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
      client.dispose();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = parseArguments(process.argv.slice(2), { http: true });
    if (args.help) process.stdout.write("Link local HTTP client: node link/http-server.mjs [--relay HTTPS_URL] [--port NUMBER]\nLoopback only. The startup bearer token stays local; only share the room invitation with your peer.\n");
    else {
      const api = createLinkHttpServer({ relayUrl: args.relayUrl, port: args.port });
      const credentials = await api.listen();
      // Explicit local credential handoff, not a request/message access log.
      process.stdout.write(`${JSON.stringify({ ...credentials, localOnly: true })}\n`);
      let stopping = false;
      const stop = async () => {
        if (stopping) return;
        stopping = true;
        await api.close();
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    }
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: publicError(error) })}\n`);
    process.exitCode = 1;
  }
}
