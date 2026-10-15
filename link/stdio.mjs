import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { LinkClient } from "./client.mjs";
import { LinkError, fields, publicError } from "./errors.mjs";
import { dispatch } from "./dispatch.mjs";
import { parseArguments } from "./arguments.mjs";

const MAX_LINE_BYTES = 64 * 1024;

export async function serveStdio({ input = process.stdin, output = process.stdout, relayUrl } = {}) {
  const client = new LinkClient({ relayUrl });
  const write = (value) => new Promise((resolveWrite, reject) => {
    output.write(`${JSON.stringify(value)}\n`, (error) => error ? reject(error) : resolveWrite());
  });

  async function line(bytes, oversized) {
    let id = null;
    try {
      if (oversized) throw new LinkError("INPUT_TOO_LARGE", "JSON lines are limited to 64 KiB.", 413);
      let request;
      try { request = JSON.parse(bytes.toString("utf8")); }
      catch { throw new LinkError("INVALID_JSON", "Each input line must be one JSON request."); }
      fields(request, ["id", "method", "params"], ["id", "method"]);
      if (!(Number.isSafeInteger(request.id) || (typeof request.id === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(request.id)))) {
        throw new LinkError("INVALID_INPUT", "Request IDs must be safe integers or short ASCII identifiers.");
      }
      id = request.id;
      const result = await dispatch(client, request.method, request.params ?? {});
      await write({ id, result });
    } catch (error) { await write({ id, error: publicError(error) }); }
  }

  let buffer = Buffer.alloc(0);
  let oversized = false;
  try {
    for await (const value of input) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      let start = 0;
      for (;;) {
        const end = chunk.indexOf(10, start);
        const part = chunk.subarray(start, end < 0 ? chunk.length : end);
        if (!oversized) {
          if (buffer.length + part.length > MAX_LINE_BYTES) {
            oversized = true;
            buffer = Buffer.alloc(0);
          } else buffer = Buffer.concat([buffer, part]);
        }
        if (end < 0) break;
        if (oversized || buffer.toString("utf8").trim()) await line(buffer, oversized);
        buffer = Buffer.alloc(0);
        oversized = false;
        start = end + 1;
      }
    }
    if (oversized || buffer.toString("utf8").trim()) await line(buffer, oversized);
  } finally { client.dispose(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = parseArguments(process.argv.slice(2));
    if (args.help) process.stdout.write("Link JSON-lines client: node link/stdio.mjs [--relay HTTPS_URL]\nKeep the process open. Supply invitations and messages through stdin, never command arguments.\n");
    else await serveStdio({ relayUrl: args.relayUrl });
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: publicError(error) })}\n`);
    process.exitCode = 1;
  }
}
