# Codex Link relay contract

This HTTP API is implemented by `dev-relay/server.mjs` for local tests and by `site/worker/index.js` for the hosted Sites + D1 relay. Hosted URLs must use HTTPS.

## Room authorization

Every room request sends `Authorization: Bearer <room-capability>`. The client derives this 256-bit capability from the invitation secret with HKDF-SHA-256 and the context label `codex-link/v1/relay-capability`. Message encryption uses a different HKDF context, so the capability does not reveal the E2E message key. The Worker stores only SHA-256(capability), never the raw capability or invitation secret.

There is no shared user-level `CODEX_LINK_ACCESS_TOKEN`, no client-side Sites bypass token, and no `OAI-Sites-Authorization` header. `CODEX_LINK_RELAY_URL` is an optional client override; otherwise the plugin uses the configured Codex Link relay URL.

The Worker requires a server-only `CODEX_LINK_RATE_LIMIT_KEY` secret for HMAC-based request-limit buckets. This key is never sent by the plugin and must not be committed or published.

## Endpoints

| Request | Purpose | Body or query |
| --- | --- | --- |
| `POST /v1/rooms` | Create a temporary room; capability is stored as a hash | `{ "roomId", "participantId" }` |
| `POST /v1/rooms/{roomId}/join` | Join as the second participant | `{ "participantId" }` |
| `GET /v1/rooms/{roomId}/status?participantId=...` | Read room metadata | — |
| `POST /v1/rooms/{roomId}/messages` | Enqueue an encrypted envelope for the peer | Strict fields `v`, `roomId`, `senderId`, `messageId`, `nonce`, `ciphertext`, `tag` |
| `GET /v1/rooms/{roomId}/messages?participantId=...&waitMs=...` | Read pending ciphertext | — |
| `POST /v1/rooms/{roomId}/acks` | Delete delivered ciphertext | `{ "participantId", "messageIds": [...] }` |
| `DELETE /v1/rooms/{roomId}` | Close the room and delete its queue | `{ "participantId" }` |

## Bounds and retention

- Room TTL is 30 minutes; message TTL is 5 minutes; each recipient queue is limited to 100 envelopes; HTTP bodies are limited to 24 KiB.
- The Site allows up to 500 active rooms, 8 room creations per source-IP HMAC bucket per 10 minutes, and 300 authenticated requests per room per minute.
- Raw source IPs are not written to the rate-limit table. The Site computes an HMAC with its server-only rate-limit key. Rate-limit rows are opportunistically removed after 24 hours.
- The Site uses D1 because independent Worker instances need shared room state. D1 contains room/participant routing data, a hash of the room capability, rate-limit bucket metadata, and ciphertext—not invitation secrets or plaintext.
- ACK, expiry, and room close are logical deletes. D1 Time Travel may allow recovery of earlier database states for up to 7 days on Workers Free or 30 days on Workers Paid.
- Limits reduce ordinary abuse; they are not DDoS protection. A public endpoint may still incur provider usage or be disrupted by distributed traffic.

The relay can observe routing metadata, approximate ciphertext size and timing, and can block, delay, discard, replay, or inject invalid packets. Clients authenticate messages and reject replayed message IDs. Local SQLite tests validate the migration and multi-instance SQL behavior, but do not replace a live two-computer test.
