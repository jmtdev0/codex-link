# Codex Link relay contract

This HTTP API is implemented by `dev-relay/server.mjs` for local tests and by `site/worker/index.js` for the hosted Sites + D1 relay. Hosted URLs must use HTTPS.

## Room authorization and protocol versions

Every room request sends `Authorization: Bearer <room-capability>`. The client derives this 256-bit capability from the invitation secret with HKDF-SHA-256 and a version-specific context label (`codex-link/v1/relay-capability` or `codex-link/v2/relay-capability`). Message encryption uses a different HKDF context, so the capability does not reveal the E2E message key. The Worker stores only SHA-256(capability), never the raw capability or invitation secret.

Protocol v1 (`cl1`) is a two-participant compatibility path. Protocol v2 (`cl2`) allows up to eight members and fans each ciphertext envelope out to every other participant. For v2, each member registers an Ed25519 SPKI public key; its participant ID must equal the first 16 bytes of SHA-256(public key), base64url-encoded. The relay stores that public key and rejects envelopes whose key does not match the registered member. Clients verify the Ed25519 message signature. The relay does not decrypt or cryptographically verify message contents.

There is no shared user-level `CODEX_LINK_ACCESS_TOKEN`, no client-side Sites bypass token, and no `OAI-Sites-Authorization` header. `CODEX_LINK_RELAY_URL` is an optional client override; otherwise the plugin uses the configured Codex Link relay URL.

The Worker requires a server-only `CODEX_LINK_RATE_LIMIT_KEY` secret for HMAC-based request-limit buckets. This key is never sent by the plugin and must not be committed or published.

## Endpoints

| Request | Purpose | Body or query |
| --- | --- | --- |
| `POST /v1/rooms` | Create a temporary room; capability is stored as a hash | `{ "roomId", "participantId", "protocolVersion", "publicKey?" }`; older clients may omit `protocolVersion` for v1 |
| `POST /v1/rooms/{roomId}/join` | Join an existing room | `{ "participantId", "protocolVersion", "publicKey?" }` |
| `GET /v1/rooms/{roomId}/status?participantId=...` | Read member IDs, roles, count, capacity, and expiry | — |
| `POST /v1/rooms/{roomId}/messages` | Fan out an encrypted envelope to every other member | V1 fields: `v`, `roomId`, `senderId`, `messageId`, `nonce`, `ciphertext`, `tag`. V2 adds `publicKey` and `signature`. |
| `GET /v1/rooms/{roomId}/messages?participantId=...&waitMs=...` | Read pending ciphertext for one member | — |
| `POST /v1/rooms/{roomId}/acks` | Delete delivered ciphertext from one member's queue | `{ "participantId", "messageIds": [...] }` |
| `POST /v1/rooms/{roomId}/leave` | Remove a non-owner participant and their queue | `{ "participantId" }` |
| `DELETE /v1/rooms/{roomId}` | Close the room and delete its queues | `{ "participantId" }`; only the owner can close a v2 room |

The v2 room code is a reusable bearer credential: anyone holding it can join until capacity or expiry. There is no per-member invitation, approval, or revocation endpoint yet. A v2 owner closes the room for everyone; other members can leave independently.

## Bounds and retention

- Room TTL is 30 minutes; message TTL is 5 minutes; each recipient queue is limited to 100 envelopes; HTTP bodies are limited to 24 KiB.
- V1 rooms permit two participants; v2 rooms permit eight.
- The Site allows up to 500 active rooms, 8 room creations per source-IP HMAC bucket per 10 minutes, and 300 authenticated requests per room per minute.
- Raw source IPs are not written to the rate-limit table. The Site computes an HMAC with its server-only rate-limit key. Rate-limit rows are opportunistically removed after 24 hours.
- The Site uses D1 because independent Worker instances need shared room state. D1 contains room/participant routing data, public signing keys, a hash of the room capability, rate-limit bucket metadata, and ciphertext—not private keys, invitation secrets, or plaintext.
- ACK, expiry, leave, and room close are logical deletes. D1 Time Travel may allow recovery of earlier database states for up to 7 days on Workers Free or 30 days on Workers Paid.
- Limits reduce ordinary abuse; they are not DDoS protection. A public endpoint may still incur provider usage or be disrupted by distributed traffic.

The relay can observe routing metadata, approximate ciphertext size and timing, and can block, delay, discard, replay, or inject invalid packets. V2 clients authenticate sender identities and reject replayed message IDs. Local SQLite tests validate migration and multi-instance SQL behavior, but they do not replace a live test with separate Codex accounts and computers.
