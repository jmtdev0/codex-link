# Optional trusted HTTPS gateway

This source is independent of `site/`, `plugin/` and the local E2E client. It is a trusted plaintext compatibility endpoint, **not** a new public plaintext route on the ciphertext relay.

See [the complete HTTPS setup/API and trust guide](../LINK_HTTPS_GATEWAY.md). Use a dedicated disposable signed-v2 room, non-sensitive tests and private vault provisioning. Close the room when finished. No independent audit or native hosted-assistant integration is claimed.

## Hosting

Use a new private Sites source checkout and the Worker ESM workflow. Persist the exact Site ID with the provided helper; declare D1 binding `DB`, configure a cryptographically random 32-byte base64url `LINK_GATEWAY_MASTER_KEY` as a server-side secret, then build and validate with:

```text
node scripts/build.mjs
node scripts/validate-artifact.mjs
```

The real `.openai/hosting.json` stays in that private checkout. This public tree includes only `hosting.json.example`, with no Site identity or secrets. Do not run the build inside the public tree without registering a separate authorized private checkout. Do not copy Git metadata, `.env` or credentials.

On Windows, the helper's Bash must understand Windows paths (for example, Git Bash, selected only for that process). GNU tar may require the process-local `TAR_OPTIONS=--force-local` so a drive-letter archive path is not treated as a remote host. Preserve the provided packaging helper; do not change global shell or Git settings.

Build output contains one standalone ESM Worker, hosting metadata and the immutable schema-only `drizzle/` migration. Use Sites' source workflow for commit/push/packaging and its native tools for saved version/deployment. A public audience requires separate human authorization; do not expose the existing loopback HTTP helper instead.

The public API fixes the relay destination server-side. Existing gateway secrets must be preserved during source updates. Master-key rotation invalidates outstanding credentials; review active rooms before doing it.
