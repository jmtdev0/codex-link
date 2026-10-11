# Codex Link

Experimental Codex plugin for connecting two agents through a temporary room. The local side encrypts and authenticates each message with AES-256-GCM before sending it; the development relay accepts encrypted envelopes only. The repository does not include a provisioned Site, project IDs, or secrets: each deployment requires its own private configuration.

## Status

- Local Codex plugin with an MCP server over `stdio` and a security-focused skill.
- Random 256-bit invitation per room; the secret is never included in relay requests.
- Per-sender key derived with HKDF-SHA-256; random nonce per message; tampering and replay are rejected.
- In-memory development relay, with no database, message files, or message-body logging.
- Tests for encryption, tampering, replay, delivery, and local acknowledgement.
- ESM Worker adapter for Sites at `site/worker/index.js`; it coordinates instances through D1 and stores metadata and ciphertext only.
- D1 logically deletes messages when they are acknowledged or expire (five minutes), and rooms after 30 minutes. Expired rows are cleaned up opportunistically; immediate physical deletion is not guaranteed.
- Provider recovery snapshots may retain ciphertext after logical deletion. Check the current D1 retention policy for your account before using it.
- Local tests verify access from two Worker instances against the same real SQLite database. This validates the SQL/protocol design; it does not replace a hosted test from two computers.

## Run the tests

Requires Node.js 20 or later. D1 SQLite integration tests run with Node.js 22.5 or later and are skipped on earlier versions. No npm packages are required:

```powershell
npm test
```

## Run the local relay

In a terminal:

```powershell
npm run relay
```

The process listens only on `127.0.0.1:8787`. Queues live in RAM, expire after five minutes, and are purged when delivery is acknowledged or the process stops. Rooms expire after 30 minutes. No message content is written to disk.

Run `npm test` for the full automated test suite; you do not need to change user environment variables or open router ports.

## Security and limitations

- The relay does not receive plaintext or the invitation secret. It can observe random IDs, participants, approximate message sizes, and timing; it can also block, delay, discard, or replay packets.
- The invitation is a bearer credential. Share it out of band and only with the intended computer. Never send it with `codex_link_send`.
- Secrets remain only in the MCP process's memory. Restarting Codex or the server requires creating a new room.
- Message text appears in both agents' conversations and is therefore visible to their models/providers and users. Encryption does not hide it from either endpoint.
- The prototype has not had an independent cryptographic audit and does not provide forward secrecy: anyone who obtains a session's invitation code could derive its keys. Use a fresh invitation for every session and never reuse codes.
- The hosted relay uses D1 because shared storage across instances is required for the bridge. D1 stores encrypted envelopes and limited metadata only; note that Time Travel history may retain deleted ciphertext longer than the logical TTL.

## Install and configure the plugin

On each computer, clone this repository and register and install the plugin from the repository root:

```powershell
codex plugin marketplace add .
codex plugin add codex-link@codex-link-local
```

Then run `plugin/scripts/configure-windows.ps1`. The setup script asks for the exact HTTPS origin of the Site and two tokens, and stores them as current-user Windows environment variables—not in the repository. Any process running as that user may be able to read those variables. Restart Codex so the plugin inherits them. Configure both computers with the same private Site and token values; share the tokens only through a trusted channel.

The plugin's `.mcp.json` starts the local server and allows only the origin configured in `CODEX_LINK_SITES_ALLOWED_ORIGIN`. A remote relay requires HTTPS and an application token separate from the E2E key; for private Sites, the service token is sent only to that exact origin.

To provision your own Site, copy `site/.openai/hosting.example.json` to `site/.openai/hosting.json` and replace the empty `project_id` with the actual ID returned when you create your private Site. The real manifest, tokens, and built artifact are local and excluded from the repository.
