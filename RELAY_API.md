# Codex Link relay contract

This is the HTTP contract expected by the local MCP plugin and implemented by both `dev-relay/server.mjs` (local RAM only) and `site/worker/index.js` (Sites + D1).

Every request uses `Authorization: Bearer <CODEX_LINK_ACCESS_TOKEN>` on a hosted endpoint. The access token is separate from the invitation secret and is not the message-encryption key. Hosted URLs must use HTTPS.

For a private ChatGPT Site, the client also sends `OAI-Sites-Authorization: Bearer <CODEX_LINK_SITES_BYPASS_TOKEN>`. Sites consumes this service-access header before invoking the Worker; the plugin sends it only when the URL origin exactly matches `CODEX_LINK_SITES_ALLOWED_ORIGIN`. The application token remains a separate check inside the Worker.

| Request | Purpose | Body or query |
| --- | --- | --- |
| `POST /v1/rooms` | Create a temporary room | `{ "roomId", "participantId" }` |
| `POST /v1/rooms/{roomId}/join` | Join as the second participant | `{ "participantId" }` |
| `GET /v1/rooms/{roomId}/status?participantId=...` | Read room metadata | — |
| `POST /v1/rooms/{roomId}/messages` | Enqueue one encrypted envelope for the peer | Envelope only; strict fields `v`, `roomId`, `senderId`, `messageId`, `nonce`, `ciphertext`, `tag` |
| `GET /v1/rooms/{roomId}/messages?participantId=...&waitMs=...` | Read pending ciphertext | — |
| `POST /v1/rooms/{roomId}/acks` | Delete delivered ciphertext | `{ "participantId", "messageIds": [...] }` |
| `DELETE /v1/rooms/{roomId}` | Close the room and delete its queue | `{ "participantId" }` |

## Sites storage and privacy contract

1. The Site uses its shared D1 binding because independent Worker instances need shared room state. D1 stores only routing IDs, expiry times, and encrypted envelopes—never the invitation secret or message plaintext.
2. Do not deliver ciphertext after five minutes. Delete messages on ACK, expired messages opportunistically, and all room rows on close; room TTL is 30 minutes.
3. D1 Time Travel may retain prior database states for up to 7 days on the free tier or 30 days on Workers Paid. SQL deletion is not a promise of immediate physical erasure from historical snapshots.
4. Enforce HTTPS, the separate bearer access token, two participants per room, request-size limits, and queue limits.
5. The relay can observe room/participant IDs, sizes, and timing, and can block, delay, discard, or replay packets. The clients authenticate ciphertext and reject replayed messages.
6. Local SQLite integration proves the SQL and multi-instance behavior against one shared database; hosted reliability still requires testing the deployed private Site from two computers.

The local development relay is deliberately loopback-only by default. It remains a separate in-process RAM implementation for protocol tests, not a public service.
