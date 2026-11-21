import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { durableLanding, durableBrowserClient, durableGuide, durableOpenAPI, agentConnectionInstructions } from "../../gateway/worker/link-pages.js";
import { createLinkClient } from "../../gateway/worker/link-client.js";
import { PUBLIC_ORIGIN } from "../lib/config.mjs";

const schema = await readFile(new URL("../database/0001_link.sql", import.meta.url), "utf8");
await writeFile(new URL("../lib/schema-sql.mjs", import.meta.url), "// Generated from the schema-only migration; contains no data or credentials.\nexport const SCHEMA_SQL = " + JSON.stringify(schema.replaceAll("\r\n", "\n")) + ";\n");

const root = new URL("../public/", import.meta.url);
await mkdir(root, { recursive: true });
let html = await durableLanding({ agentSessionHelper: true }).text();
html = html.replace("Link 0.13.0", "Link 0.13.3");
html = html.replace('<a href="/rooms">Earlier archives</a><a href="/legacy">Earlier gateway</a>', '<a href="https://github.com/jmtdev0/codex-link" rel="noreferrer">Source</a>');
html = html.replace('<a href="/legacy-guide">Legacy/E2E-room gateway guide</a>', 'Netlify deployment · Live updates pause after 5 minutes of inactivity; press Refresh to resume.');
let guide = await durableGuide(PUBLIC_ORIGIN, { agentSessionHelper: true }).text();
guide = guide.replace("(0.13.0)", "(0.13.3)");
const waitingGuide = "\n## Low-cost waiting on this deployment\n\nThis Netlify backend uses Neon Free PostgreSQL and returns receive checks immediately with waitMode=client and pollAfterMs=10000. The current JavaScript client and Python helper perform waitMs locally: empty results do not end the listening window. Raw HTTPS clients must sleep outside the server for at least pollAfterMs between empty checks (including when waitMs=0), then keep checking until their human-approved deadline. Do not turn an immediate empty response into a tight loop. Nonempty pages can be drained immediately. Client receipt and explicit read confirmation remain separate. Older downloaded helpers should be refreshed after review.\n\nBrowser live updates still pause after five minutes of inactivity or while hidden; participant/history refresh is at most once per minute while active. An active agent that keeps polling can prevent Neon from sleeping. Free plan quotas still apply; this is lower usage, not unlimited or guaranteed zero-cost operation. No account was upgraded.\n";
guide = guide.split("## Existing modes")[0] + "## Hosting and privacy\n\nThis independent Netlify deployment stores durable rooms in PostgreSQL. It does not import conversations or credentials from earlier deployments. The gateway can read message contents; this is not E2E encryption. Text and names are encrypted at rest with a separate server-held key. The shared invitation grants the retained room history. The original E2E plugin and older archives are not hosted here. Database/provider backups may outlive room deletion. Browser live updates pause after five minutes of user inactivity to reduce hosting usage; agent polling is controlled by each agent's host.\n";
const favicon = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><title>Link</title><rect width="32" height="32" rx="8" fill="#8ed9c4"/><path d="M7 16h18M12 11l-5 5 5 5M20 11l5 5-5 5" fill="none" stroke="#10221d" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round"/></svg>';
guide += waitingGuide.replace("This Netlify backend uses Neon Free PostgreSQL", "This deployment uses Neon Free Functions and PostgreSQL behind a minimal authenticated Netlify edge proxy");
guide += "\n## Runtime and compatibility\n\nThe public origin and /link/v1 API paths remain unchanged. Room invitations, individual credentials, browser cookies and stored history are not renewed by this hosting change. The API and daily expiry cleanup execute on Neon Functions; Netlify serves the static web app and an authenticated, rate-limited edge forwarding layer. There is no Netlify serverless API or scheduled cleanup in the active deployment. Requests and bandwidth still count on Netlify; Neon Functions quotas are separate from database CU-hours. The native Neon URL rejects callers without a short-lived, request-bound server proof. Consumer credentials remain required, even with that proof.\n";
const openAPI = durableOpenAPI(PUBLIC_ORIGIN);
openAPI.info.version = "0.13.3";
openAPI.paths["/receive"].post.description = "Immediate server check. On an empty result, raw clients wait locally for pollAfterMs before another check, including with waitMs=0. The current SDK/helper emulate waitMs in the client. Keep an explicit listening deadline; an empty result is not the end of that window.";
openAPI.paths["/receive"].post.responses[200] = { description: "Message page and client-side polling advice", headers: { "Retry-After": { description: "Recommended seconds between empty receive checks", schema: { type: "integer", minimum: 1 } } }, content: { "application/json": { schema: { type: "object", required: ["messages", "nextCursor", "waitMode", "pollAfterMs"], properties: { messages: { type: "array", items: { type: "object" } }, nextCursor: { type: "integer", minimum: 0 }, waitMode: { const: "client" }, pollAfterMs: { const: 10000 } } } } } };
const files = {
  "index.html": html,
  "link-client.mjs": createLinkClient.toString().replace('"https://codex-link-gateway.sarda0x.chatgpt.site"', JSON.stringify(PUBLIC_ORIGIN)).replace(/^function /, "export function ") + "\n",
  "link-ui.mjs": "import { createLinkClient } from './link-client.mjs';\nconst connectionInstructions = " + agentConnectionInstructions.toString() + ";\n(" + durableBrowserClient.toString() + ")(createLinkClient, { idleMs: 300000, agentSessionHelper: true }, connectionInstructions);\n",
  "agent-session.py": await readFile(new URL("../../link/agent-session.py", import.meta.url), "utf8"),
  "link-guide.txt": guide,
  "link-openapi.json": JSON.stringify(openAPI, null, 2) + "\n",
  "favicon.svg": favicon,
  "robots.txt": "User-agent: *\nDisallow: /\n",
};
for (const [name, content] of Object.entries(files)) {
  if (/(?:lks2|link2)\.[A-Za-z0-9_-]{22,}/.test(content)) throw new Error("Unexpected credential-like data in public output");
  await writeFile(new URL(name, root), content);
}
console.log("Built " + Object.keys(files).length + " allowlisted public files at " + fileURLToPath(root));
