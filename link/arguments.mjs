import { LinkError } from "./errors.mjs";

export function parseArguments(args, { http = false } = {}) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--relay" && index + 1 < args.length) options.relayUrl = args[++index];
    else if (http && arg === "--port" && index + 1 < args.length && /^\d{1,5}$/.test(args[index + 1])) options.port = Number(args[++index]);
    else throw new LinkError("INVALID_ARGUMENTS", "Use --relay HTTPS_URL, optionally --port NUMBER for HTTP mode. Never put codes, tokens, or messages in command arguments.");
  }
  return options;
}
