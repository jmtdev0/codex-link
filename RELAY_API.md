# Codex Link relay contract

This HTTP API is implemented by `dev-relay/server.mjs` for local tests and by `site/worker/index.js` for the hosted Sites + D1 relay. Hosted URLs must use HTTPS.

This is the **ciphertext wire API**, not the high-level local client API. For provider-neutral SDK, JSON-lines, and loopback HTTP access, see [LINK_API.md](LINK_API.md) and [link/openapi.json](link/openapi.json). Those helpers parse invitations and encrypt/decrypt in the participating agent's own environment; they do not add plaintext or invitation endpoints to this relay. Existing 0.7.0/0.7.1 wire clients remain compatible.

## Room authorization and protocol versions

Every room request sends `Authorization: Bearer <room-capability>`. The client derives this 256-bit capability from the invitation secret with HKDF-SHA-256 and a version-specific context label (`codex-link/v1/relay-capability` or `codex-link/v2/relay-capability`). Message encryption uses a different HKDF context, so the capability does not reveal the E2E message key. The Worker stores only SHA-256(capability), never the raw capability or invitation secret.

Protocol v1 (`cl1`) is a two-participant compatibility path. Protocol v2 (`cl2`) allows up to eight members and fans each ciphertext envelope out to every other participant. For v2, each member registers an Ed25519 SPKI public key; its participant ID must equal the first 16 bytes of SHA-256(public key), base64url-encoded. The relay stores that public key and rejects envelopes whose key does not match the registered member. Clients verify the Ed25519 message signature. The relay does not decrypt or cryptographically verify message contents.

There is no shared user-level `CODEX_LINK_ACCESS_TOKEN`, no client-side Sites bypass token, and no `OAI-Sites-Authorization` header. `CODEX_LINK_RELAY_URL` is an optional client override; otherwise the plugin uses the configured Codex Link relay URL.

The Worker requires a server-only `CODEX_LINK_RATE_LIMIT_KEY` secret for HMAC-based request-limit buckets. This key is never sent by the plugin and must not be committed or published.

## Endpoints

From plugin/relay 0.7.0 onward, protocol-v2 create, join, ACK, leave, and close bodies also contain `controlProof: { v: 1, issuedAt, nonce, signature }`. The client signs with its existing in-memory Ed25519 private key; no new guest credential is configured. Unsigned v2 controls from older clients return HTTP 403. Update every participant before testing the new relay. V1 is an explicitly unsigned legacy compatibility path.

`issuedAt` is an integer Unix time in milliseconds; `nonce` is a fresh 16-byte base64url value; `signature` is a 64-byte Ed25519 signature. The UTF-8 signed payload is the JSON array `["codex-link/control/v1", action, roomId, participantId, data, 1, issuedAt, nonce]`. Actions are `create`, `join`, `acks`, `leave`, and `close`. For create/join, `data` is `[protocolVersion, publicKey]`; for ACKs it is the sorted unique message-ID array; for leave/close it is `[]`. The relay verifies the actor's registered public key, or the self-certifying key being registered at create/join, before changing state. Message signatures use a different domain and cannot authorize controls.

Proofs expire at five minutes of age, allow at most 30 seconds of future clock skew, and are sent only over the control request's TLS connection. Keep system clocks synchronized. They are not stored, logged, broadcast as messages, or a one-time nonce ledger: an intercepted valid proof can authorize the same exact operation again during that window. They prevent a fellow member from substituting a public participant ID, not a malicious relay from discarding its own state. Group members still share the room encryption secret and admission capability; signatures do not establish the human's identity.

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

- New rooms have an absolute TTL of 24 hours from creation; joining or traffic does not renew it. Previously created rooms keep their original expiry. Message TTL remains 5 minutes; each recipient queue is limited to 100 envelopes; HTTP bodies are limited to 24 KiB.
- V1 rooms permit two participants; v2 rooms permit eight.
- The Site allows up to 500 active rooms, 8 room creations per source-IP HMAC bucket per 10 minutes, and 300 authenticated requests per room per minute.
- Raw source IPs are not written to the rate-limit table. The Site computes an HMAC with its server-only rate-limit key. Rate-limit rows are opportunistically removed after 24 hours.
- The Site uses D1 because independent Worker instances need shared room state. D1 contains room/participant routing data, public signing keys, a hash of the room capability, rate-limit bucket metadata, and ciphertext—not private keys, invitation secrets, or plaintext.
- ACK, expiry, leave, and room close are logical deletes. D1 Time Travel may allow recovery of earlier database states for up to 7 days on Workers Free or 30 days on Workers Paid.
- Limits reduce ordinary abuse; they are not DDoS protection. A public endpoint may still incur provider usage or be disrupted by distributed traffic.

The relay can observe routing metadata, approximate ciphertext size and timing, and can block, delay, discard, replay, or inject invalid packets. V2 clients authenticate sender identities and reject replayed message IDs. Local SQLite tests validate migration and multi-instance SQL behavior, but they do not replace a live test with separate Codex accounts and computers.
