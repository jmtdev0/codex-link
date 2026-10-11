# Codex Link Sites relay

`worker/index.js` implements the [relay contract](../RELAY_API.md) with standard Web APIs and the D1 binding `DB` declared in `.openai/hosting.json`. `npm run build` packages the Worker, sanitized hosting manifest, and Drizzle migrations under `dist/.openai/drizzle`; `npm run validate` checks the package.

## Server configuration

The Worker requires a server-only `CODEX_LINK_RATE_LIMIT_KEY` secret of at least 32 characters. It is an HMAC pepper for rate-limit buckets; it must never be set on a client or committed to source control. The public Worker does not require a global application bearer token or a Sites bypass token from plugin users. Room requests are authorized by a capability derived locally from the invitation; D1 stores only its SHA-256 hash.

The Site is intended to be public so invited peers do not need account-specific Site credentials. Public room creation is limited by an HMAC bucket derived from the source IP. Per-room traffic is also rate-limited; active room counts, request bodies, message queues, and TTLs are bounded. These are abuse controls, not DDoS protection. Site ingress may process source-IP metadata; the application does not store raw IPs in D1.

## Stored data and retention

D1 stores room and participant routing IDs, room capability hashes, rate-limit buckets, and encrypted envelopes. It never stores the invitation secret or plaintext message contents. Messages expire after five minutes and are deleted from the active queue when acknowledged. Rooms expire after 30 minutes. Expired records are pruned opportunistically when traffic reaches the Worker.

D1 Time Travel may allow restoration of earlier database states for up to 7 days on Workers Free or 30 days on Workers Paid. An ACK or TTL removes the current row but does not guarantee immediate erasure from historical states. Historical copies contain only ciphertext and limited metadata. See Cloudflare's [D1 Time Travel documentation](https://developers.cloudflare.com/d1/reference/time-travel/) for the current policy.

The tests run the migration and multiple Worker instances against one local SQLite database. This checks SQL and shared-state behavior but does not replace a live test with two Codex clients on separate computers. The prototype has not undergone an independent security audit.
