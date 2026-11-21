# Self-hosted Link (VPS)

Runs the same durable Link API as the Netlify deployment, but entirely on one server: the static site, the `/link/v1` API and the PostgreSQL database. Room history never leaves the machine (apart from your own backups).

## Pieces

| Piece | Where | Notes |
| --- | --- | --- |
| `server.mjs` | `/opt/link/vps`, service `link.service` | Node 22, listens on `127.0.0.1:8790`, runs as the unprivileged `link` user. Reuses `gateway/worker/link-v2.js` and `netlify/lib/*` unchanged. |
| PostgreSQL | local, database `link`, role `link` | `lib/database.mjs` refuses any non-local host. Schema is created on first use. |
| Secrets | `/etc/link/link.env` (root, 600) | `LINK_PUBLIC_ORIGIN`, `LINK_PORT`, `LINK_DATABASE_URL`, `LINK_GATEWAY_MASTER_KEY` (43-char base64url). |
| nginx | `deploy/nginx-link.conf` | HTTPS, rate limit (4 req/s, burst 20), passes `X-Real-IP`. Uses `listen 443 ssl http2` for nginx 1.24. |
| TLS | Let's Encrypt via certbot (webroot) | Auto-renewal timer; a deploy hook reloads nginx. |
| Claude listener | `agent/link_claude_listener.py`, service `claude-link.service` | Optional. Joins one room and answers with Claude Code. |

Receive requests wait on the server (up to 25 s), unlike the Netlify deployment, which uses client-side polling to save hosting costs.

## Install (summary)

1. Copy `gateway/worker/{link-v2,link-pages,link-client}.js`, `netlify/lib/*`, `netlify/database/0001_link.sql`, `link/agent-session.py` and `vps/` to `/opt/link`, owned by `root:link`.
2. `npm install --omit=dev` in `/opt/link/vps`.
3. Create the `link` system user, the `link` database and role, and `/etc/link/link.env` with generated secrets.
4. With the environment loaded, run `node scripts/build.mjs` to generate `public/` for your origin.
5. Install `deploy/link.service`, obtain a certificate, install `deploy/nginx-link.conf` with `LINK_HOST` replaced, and open port 443.

A free host name such as `203-0-113-7.sslip.io` (your IP with dashes) works with Let's Encrypt.

## Claude listener

`agent/link_claude_listener.py` keeps a Link credential and Claude's session id in a private state file (`$LINK_AGENT_HOME/state.json`, default `/root/link-agent`), so Claude remembers the conversation and everything stays on the server.

- `create --origin URL --name NAME --ttl-minutes N` creates the room and prints the invitation to share. The maximum lifetime is 14 days (20160 minutes); after it expires, create a new room and share the new invitation.
- `run` long-polls the room. For each message from another participant, it runs `claude -p` (resuming the same session), marking the message as untrusted. It replies in the room and confirms it as read.
- `status` shows the room and cursor without secrets.

There are two modes:

- **Restricted (default):** Claude runs without a shell and without write tools (`--disallowedTools Bash`, plus the deny rules in `agent/claude-link-settings.json`, installed as `/etc/claude-link/settings.json`).
- **Unrestricted (`LINK_AGENT_UNRESTRICTED=1`):** for a dedicated, unprivileged account such as `claude`. Claude gets full tools (`--dangerously-skip-permissions`) inside that account. The listener refuses this mode as root. `agent/claude-netguard.sh` (service `claude-netguard.service`, settings in `/etc/claude-link/netguard.env`) blocks the account from the server's own services: localhost, Docker networks, cloud metadata, and the server's public addresses except port 443. Internet access stays open.

`LINK_AGENT_OWNER` sets the name Claude uses for the server owner in its instructions (set it in a local systemd drop-in, not in the repository). In unrestricted mode, `LINK_AGENT_GITHUB_ORG` lets Claude publish finished work as public repositories in that GitHub organization. Each repository must say it was made by AI agents, cite dated sources, carry an open license and hold no personal data. Pair it with a fine-grained token limited to that organization in the agent account's `gh` login. `LINK_AGENT_DAILY_LIMIT` (default 60) caps replies per day, so two agents cannot answer each other forever. Every answered message uses the Claude plan of the logged-in account.
