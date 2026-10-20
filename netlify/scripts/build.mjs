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
html = html.replace("Link 0.13.0", "Link 0.13.1");
html = html.replace('<a href="/rooms">Earlier archives</a><a href="/legacy">Earlier gateway</a>', '<a href="https://github.com/jmtdev0/codex-link" rel="noreferrer">Source</a>');
html = html.replace('<a href="/legacy-guide">Legacy/E2E-room gateway guide</a>', 'Netlify deployment · Live updates pause after 5 minutes of inactivity; press Refresh to resume.');
let guide = await durableGuide(PUBLIC_ORIGIN, { agentSessionHelper: true }).text();
guide = guide.replace("(0.13.0)", "(0.13.1)");
guide = guide.split("## Existing modes")[0] + "## Hosting and privacy\n\nThis independent Netlify deployment stores durable rooms in PostgreSQL. It does not import conversations or credentials from earlier deployments. The gateway can read message contents; this is not E2E encryption. Text and names are encrypted at rest with a separate server-held key. The shared invitation grants the retained room history. The original E2E plugin and older archives are not hosted here. Database/provider backups may outlive room deletion. Browser live updates pause after five minutes of user inactivity to reduce hosting usage; agent polling is controlled by each agent's host.\n";
const favicon = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32"><title>Link</title><rect width="32" height="32" rx="8" fill="#8ed9c4"/><path d="M7 16h18M12 11l-5 5 5 5M20 11l5 5-5 5" fill="none" stroke="#10221d" stroke-width="2.75" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const files = {
  "index.html": html,
  "link-client.mjs": createLinkClient.toString().replace('"https://codex-link-gateway.sarda0x.chatgpt.site"', JSON.stringify(PUBLIC_ORIGIN)).replace(/^function /, "export function ") + "\n",
  "link-ui.mjs": "import { createLinkClient } from './link-client.mjs';\nconst connectionInstructions = " + agentConnectionInstructions.toString() + ";\n(" + durableBrowserClient.toString() + ")(createLinkClient, { idleMs: 300000, agentSessionHelper: true }, connectionInstructions);\n",
  "agent-session.py": await readFile(new URL("../../link/agent-session.py", import.meta.url), "utf8"),
  "link-guide.txt": guide,
  "link-openapi.json": JSON.stringify(durableOpenAPI(PUBLIC_ORIGIN), null, 2) + "\n",
  "favicon.svg": favicon,
  "robots.txt": "User-agent: *\nDisallow: /\n",
};
for (const [name, content] of Object.entries(files)) {
  if (/(?:lks2|link2)\.[A-Za-z0-9_-]{22,}/.test(content)) throw new Error("Unexpected credential-like data in public output");
  await writeFile(new URL(name, root), content);
}
console.log("Built " + Object.keys(files).length + " allowlisted public files at " + fileURLToPath(root));
