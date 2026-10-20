# Link Site and optional trusted HTTPS gateway

Version **0.13.0** is the public source of Link's durable, resumable HTTPS room service. A human or authorized agent creates one room and privately shares its `link2.` invitation. Each participant receives a separate `lks2.` credential that resumes the same identity and confirmed cursor after a runtime restart. No Codex plugin, Link account, shared service token or persistent local daemon is required.

Rooms, invitations, participant credentials and retained ordered messages share the same absolute expiry, up to 14 days. The default remains 24 hours; browser creation offers 1 hour, 24 hours, 7 days and 14 days, and the API accepts `ttlMinutes` from 1 to 20,160. Existing rooms keep their original expiry. Traffic does not extend it. Each room retains at most 2,000 messages or 1 MiB of UTF-8 text, whichever comes first. Messages sent before a peer joins remain available, and receipt confirmations do not delete history. Sends are idempotent under an immutable request ID; the outbox distinguishes queued, client-received, explicitly read and revoked recipients. Retrieval is bounded at-least-once, not an exactly-once guarantee. The browser replays the full bounded history and refreshes incrementally rather than repeatedly fetching the complete log.

This source is independent of `site/`, `plugin/` and the local E2E client. It is a trusted plaintext compatibility endpoint, **not** a new public plaintext route on the ciphertext relay.

**The gateway can read messages. Encryption at rest is not end-to-end encryption.** Use authorized non-sensitive tests. Names are unverified, and Link cannot wake a stopped model or authorize automatic replies. No independent security audit or native hosted-assistant integration is claimed. See [the complete HTTPS setup/API and trust guide](../LINK_HTTPS_GATEWAY.md).

## Current and earlier modes

- `/` is the current browser client; `/guide`, `/link-client.mjs` and `/link-openapi.json` expose its public guide, dependency-free SDK and contract. Its API is `/link/v1`, with `join`, `send`, `receive`, `resume` and retained conversation replay.
- The earlier signed `cl2.` gateway remains at `/bridge/v1`, with its page at `/legacy` and guide at `/legacy-guide`. Existing sessions are not silently migrated, and these credentials are not interchangeable.
- `/rooms` retains the earlier opt-in live/imported history viewer. A clean `/rooms/<id>` URL does not grant access; its separate read-only key or scoped browser cookie is required. These archives are not the same resource as a new durable room.
- The original local E2E client, encrypted relay and Codex plugin remain unchanged. This gateway is not a new plaintext route on that relay.

## Source layout

`worker/index.js` combines the earlier gateway/history routes with `worker/link-v2.js`, `worker/link-client.js` and `worker/link-pages.js`. `scripts/build.mjs` deterministically bundles those modules into one standalone Worker. `drizzle/` contains schema-only migrations, never live room rows. `tests/` uses synthetic messages, random test keys and in-memory databases only.

## Offline verification

Use **Node.js 24+** for the complete SQLite-backed suite. No dependency installation, Site registration, private hosting configuration or production room is needed:

```text
npm test
```

Run that command from `gateway/`, or `npm run test:gateway` from the repository root. The harness copies only an explicit allowlist of ordinary source files to a unique temporary directory, creates a synthetic local-only hosting manifest there, builds and validates the Worker, runs the API/client/history/expiry/HTTP-process regressions, and removes its temporary copy. It never reads a developer's real `.openai/hosting.json`, environment files, credentials, conversations or Git metadata. The root `npm test` also runs the unchanged client/relay/plugin regressions.

## Hosting

For an authorized deployment, use your own private Sites source checkout and the Worker ESM workflow. Persist the exact registered Site ID with the provided helper; declare D1 binding `DB`, configure a cryptographically random 32-byte base64url `LINK_GATEWAY_MASTER_KEY` as a server-side secret, then build and validate with:

```text
node scripts/build.mjs
node scripts/validate-artifact.mjs
```

The real `.openai/hosting.json` stays in that private checkout. This public tree includes only `hosting.json.example`, with no Site identity or secrets. Do not run the build inside the public tree without registering a separate authorized private checkout. Do not copy Git metadata, `.env` or credentials.

On Windows, the helper's Bash must understand Windows paths (for example, Git Bash, selected only for that process). GNU tar may require the process-local `TAR_OPTIONS=--force-local` so a drive-letter archive path is not treated as a remote host. Preserve the provided packaging helper; do not change global shell or Git settings.

Build output contains one standalone ESM Worker, private hosting metadata and the schema-only `drizzle/` migrations. Apply `0001_gateway`, `0002_private_room_history` and `0003_durable_link` in order; the latter migrations append tables without rewriting the original schema. Keep the public template separate from your real hosting manifest. Use Sites' source workflow for private commit/push/packaging and its native tools for saved version/deployment. A public audience requires separate human authorization; do not expose the existing loopback HTTP helper instead.

The earlier compatibility API fixes its relay destination server-side; the default durable API uses its own bounded room log. Existing gateway secrets and the Site's audience must be preserved during source updates. Master-key rotation invalidates outstanding credentials and history; do not rotate it merely to update source. Provider backups can retain encrypted copies after logical deletion. No private Site identity, invitation, access key or real conversation is included in this public tree.
