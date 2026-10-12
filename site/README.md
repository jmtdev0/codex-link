# Codex Link Sites relay

`worker/index.js` implements the [relay contract](../RELAY_API.md) with standard Web APIs and the D1 binding `DB` declared in `.openai/hosting.json`. `npm run build` packages the Worker, sanitized hosting manifest, and Drizzle migrations under `dist/.openai/drizzle`; `npm run validate` checks the package.

## Server configuration

The Worker requires a server-only `CODEX_LINK_RATE_LIMIT_KEY` secret of at least 32 characters. It is an HMAC pepper for rate-limit buckets; it must never be set on a client or committed to source control. The public Worker does not require a global application bearer token or a Sites bypass token from plugin users. Room requests are authorized by a capability derived locally from the room code; D1 stores only its SHA-256 hash.

The Site is intended to be public so invited peers do not need account-specific Site credentials. Public room creation is limited by an HMAC bucket derived from the source IP. Per-room traffic is also rate-limited; active room counts, request bodies, message queues, and TTLs are bounded. These are abuse controls, not DDoS protection. Site ingress may process source-IP metadata; the application does not store raw IPs in D1.

## Stored data and retention

The 0.7.0 Worker also requires participant signatures on v2 create/join/ACK/leave/close requests. A shared room capability authorizes admission, not impersonation of an existing member or owner. The Worker verifies Ed25519 using Web Crypto before state changes. Upgrade v2 clients together; older unsigned controls fail with HTTP 403. V1 remains an unsigned legacy path. Proofs stay in the control request and are not stored or broadcast; their short validity window is not a durable replay ledger. No storage migration is required. See [the relay contract](../RELAY_API.md).

D1 stores room and participant routing IDs, protocol version, participant roles and public signing keys, room capability hashes, rate-limit buckets, and encrypted envelopes. It never stores private signing keys, the invitation secret, or plaintext message contents. V1 rooms permit two participants; v2 group rooms permit eight. Messages expire after five minutes and are deleted from the active queue when acknowledged or when a participant leaves. New rooms expire 24 hours after creation; joins and traffic do not extend this deadline, and existing rooms keep their originally stored expiry. Expired records are pruned opportunistically when traffic reaches the Worker.

The longer room lifetime does not add persistent local identities, transcript recovery, automatic consent renewal, or additional message retention. Invitation codes remain bearer secrets and must stay out of public source, relay payloads, and logs.

D1 Time Travel may allow restoration of earlier database states for up to 7 days on Workers Free or 30 days on Workers Paid. An ACK, leave, or TTL removes the current row but does not guarantee immediate erasure from historical states. Historical copies contain only ciphertext and limited metadata. See Cloudflare's [D1 Time Travel documentation](https://developers.cloudflare.com/d1/reference/time-travel/) for the current policy.

The tests run all migrations and multiple Worker instances against one local SQLite database. This checks SQL and shared-state behavior but does not replace a live test with multiple Codex clients on separate computers. The prototype has not undergone an independent security audit.
