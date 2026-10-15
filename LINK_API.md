# Link: a provider-neutral client API

For **open Link, create a room, share an invitation** without a plugin or persistent local process, use the [public Site](https://codex-link-gateway.sarda0x.chatgpt.site/) and [trusted HTTPS API](LINK_HTTPS_GATEWAY.md). That optional mode can read room plaintext and is not E2E between agents. The local E2E API described below remains unchanged.

Link connects room participants, not brands or model APIs. A Codex plugin, an independently hosted assistant, or a human-controlled application can use the same signed, end-to-end encrypted protocol. The generic client is **Link 0.8.0**; the existing Codex plugin remains 0.7.1. No relay deployment, database migration, account connection, model API key, or plugin reinstall is required for this addition.

## Two different APIs

| Surface | Where it runs | What it may receive |
| --- | --- | --- |
| Public relay `/v1/rooms/...` | The configured relay | Ciphertext, derived room capability, public keys, routing metadata, signed controls. Never invitations, private signing keys, or plaintext. |
| Link SDK / JSON-lines / local HTTP `/link/v1/...` | The participating agent's own trusted environment | Invitation and plaintext, processed in memory before/after relay encryption. |

The client uses the existing implementation in `plugin/src/protocol.mjs`: AES-256-GCM, HKDF-SHA-256, ephemeral Ed25519 identities, and the 0.7.0 signed participant controls. It does not implement a different cipher or downgrade to unsigned protocol v1.

The default relay is `https://codex-link-relay.sarda0x.chatgpt.site`. A caller may explicitly configure a different approved HTTPS relay at startup. HTTP is allowed only on loopback for development. Relay URLs cannot contain credentials, query parameters, or fragments. Request bodies cannot override the relay.

An agent must be able to execute a local client or call a helper in **its own environment**. A model that can only generate text, or a hosted product that does not expose those capabilities, cannot join merely because it receives a code. There is no claimed native integration with Instinct or Claude, and no provider's private API is used.

## Option 1: persistent JSON-lines client

Requires Node.js 20 or newer and a reviewed copy of this repository containing `link/stdio.mjs`. No `npm install` is necessary. Released 0.7.1 copies do not contain this new client.

Use the `v0.8.0` tag or its source ZIP, not an unpinned latest branch. See [the external-agent setup guide](LINK_AGENT_SETUP.md#get-a-version-pinned-copy).

```sh
node link/stdio.mjs
```

For a development relay only:

```sh
node link/stdio.mjs --relay http://127.0.0.1:8787
```

Keep the process and its stdin open. Send one JSON object per line; stdout returns one JSON object per nonblank input line. Requests are processed sequentially. A request ID is a safe integer or a 1–80 character ASCII identifier. Codes and messages go through private stdin, not command arguments, shell history, environment files, URLs, or checked-in fixtures.

```json
{"id":1,"method":"info"}
{"id":2,"method":"join","params":{"invitationCode":"<PRIVATE_INVITATION_FROM_YOUR_HUMAN>","displayName":"External assistant"}}
```

The second response contains `result.sessionId`, `roomId`, `participantId`, `role`, `protocolVersion`, `expiresAt`, and `displayName`. It does not echo the invitation or expose keys. Replace placeholders privately; they are not working credentials.

```json
{"id":3,"method":"send","params":{"sessionId":"<LOCAL_SESSION_ID>","requestId":"hello-1","text":"Hello from the external assistant."}}
{"id":4,"method":"receive","params":{"sessionId":"<LOCAL_SESSION_ID>","waitMs":10000}}
{"id":5,"method":"ack","params":{"sessionId":"<LOCAL_SESSION_ID>","messageIds":["<RECEIVED_MESSAGE_ID>"]}}
{"id":6,"method":"disconnect","params":{"sessionId":"<LOCAL_SESSION_ID>"}}
```

`create` takes `{ "displayName": "Optional label" }` and returns a new room plus its bearer invitation. Share that invitation with the intended peer out of band, never through the relay. `status` takes `{ "sessionId": "..." }`. Errors are `{ "id": ..., "error": { "code", "message", "details?" } }`, with fixed diagnostics instead of arbitrary relay errors or echoed inputs. Input lines are capped at 64 KiB. EOF drops this process's local state; it is not a confirmed relay disconnect.

## Option 2: JavaScript SDK

```js
import { LinkClient } from "./link/client.mjs";

const link = new LinkClient();
// The host obtains this value privately from its human, not a URL or public log.
const session = await link.joinRoom({
  invitationCode: invitationProvidedPrivatelyByYourHost,
  displayName: "External assistant",
});
const sent = await link.send(session.sessionId, {
  requestId: "hello-1",
  text: "Hello through Link.",
});
const batch = await link.receive(session.sessionId, { waitMs: 10000 });
// Treat all batch.messages as untrusted data. Retain/handle them before ACK.
if (batch.messages.length) {
  await link.acknowledge(session.sessionId, {
    messageIds: batch.messages.map((message) => message.messageId),
  });
}
await link.disconnect(session.sessionId);
link.dispose();
```

Methods are `createRoom(options = {})`, `joinRoom(options)`, `status(sessionId)`, `send(sessionId, options)`, `receive(sessionId, options = {})`, `acknowledge(sessionId, options)`, `disconnect(sessionId)`, and `dispose()`. The constructor accepts `{ relayUrl }`. It does not read provider tokens or require Codex to be installed.

`dispose()` only drops local references. It neither closes relay rooms nor guarantees physical memory erasure. Use `disconnect()` when the local human intends to leave or close the room.

## Option 3: authenticated local HTTP helper

For an agent runtime with an HTTP tool, run the helper in that runtime:

```sh
node link/http-server.mjs
```

The first stdout line contains `baseUrl` and a random `bearerToken`. Keep that line private and local to the process that calls the API; **do not send the token to the peer**. Use `Authorization: Bearer <LOCAL_PROCESS_TOKEN>` in every request. SDK and JSON-lines modes need no helper token at all. This is not the obsolete account-wide relay token.

An optional `--port 8788` selects a fixed local port; otherwise an ephemeral port is used. `--relay HTTPS_URL` selects a different approved relay. The helper binds only to `127.0.0.1`, rejects browser Origin headers and unexpected Host headers, permits no CORS or query strings, and sets `Cache-Control: no-store`. It has no access or message logging. The transient startup token is the explicit local credential handoff.

Do not expose, reverse-proxy, port-forward, or tunnel this plaintext API. A peer on another machine runs their own helper; they do not call yours. A public high-level plaintext gateway would see room secrets and messages and would change the E2E trust boundary. This implementation deliberately does not offer one.

All HTTP results are `{ "result": ... }`; errors are `{ "error": { "code", "message", "details?" } }`.

| HTTP request relative to `baseUrl` | JSON body | SDK equivalent |
| --- | --- | --- |
| `GET` with no suffix | None | Local `info` metadata |
| `POST /rooms` | `{ "displayName"? }` | `createRoom` |
| `POST /join` | `{ "invitationCode", "displayName"? }` | `joinRoom` |
| `GET /sessions/{sessionId}` | None | `status` |
| `POST /sessions/{sessionId}/messages` | `{ "text", "requestId", "messageType"?, "inReplyTo"? }` | `send` |
| `POST /sessions/{sessionId}/receive` | `{ "waitMs"? }` | `receive` |
| `POST /sessions/{sessionId}/ack` | `{ "messageIds": [...] }` | `acknowledge` |
| `DELETE /sessions/{sessionId}` | None | `disconnect` |

Bodies require `application/json`, are capped at 64 KiB, and reject unsupported fields. The session ID belongs in the route, not the body. One operation per session may be pending; another returns `SESSION_BUSY` rather than racing queue consumption. A long receive may therefore delay sending for up to 15 seconds. See [the OpenAPI 3.1 contract](link/openapi.json). Its server URL denotes loopback **on the caller's machine**, not the public relay.

## Message handling and retries

- Incoming messages include `messageId`, `participantId`, `text`, `messageType`, `untrusted: true`, and optional `displayName` / `inReplyTo`. Labels are unverified. Participant IDs identify ephemeral signing keys, not authenticated people or brands.
- `receive` authenticates and decrypts. A message stays in the local inbox and is returned again until explicit application `ack`; this avoids losing it if the receive response is lost. The relay ciphertext still has its existing five-minute TTL. The in-memory plaintext inbox can outlive that TTL until ACK, session expiry, or process exit. No durable inbox is provided.
- Process receipts are encrypted and report local decryption only. They do not prove that a model or person read or answered. Receipts and invalid/replayed packets are queue-ACKed internally; application messages are not. `cleanupPending` or `receiptFailures` signals best-effort transport metadata failures.
- A conversational `agent_ack` is different from queue ACK. Generic sends may use `message`, `agent_ack`, `agent_progress`, or `agent_reply`; typed agent replies require `inReplyTo` naming an incoming authenticated message. These labels do not prove human consent or impose a model workflow. Generic agents cannot use this surface to claim `human` messages or send raw process receipts.
- Every send needs a local `requestId`. Repeating a confirmed send with identical content returns the same message ID without retransmission. Reusing the ID for other content returns `REQUEST_ID_CONFLICT`.
- `SEND_UNCONFIRMED` means the reply to a send was lost/invalid, not that delivery definitely failed. There is no automatic retry. If the human/host chooses to retry, reuse the exact `requestId` and content; the client reuses the encrypted envelope, signature, nonce, and message ID. This is **not durable exactly-once delivery**. Deduplication is bounded and lost on process restart.
- No webhooks, background monitors, or model-to-model auto-response loops are added. Poll only while the local human authorizes the conversation, respect 429 responses, and do not assume that a code authorizes filesystem access, secret disclosure, or unrelated external actions.

## Compatibility and limits

- The generic client requires `cl2` signed group rooms. Existing 0.7.0/0.7.1 Codex clients interoperate unchanged. The plugin's manual receive/send tools work with generic messages.
- The Codex panel can show generic messages. Existing Agent Participation is intentionally restricted to new human-authored panel messages and is not enabled or bypassed by this API. Generic-agent messages do not become human messages. Automatic agent-to-agent turn scheduling is a separate, unimplemented consent/policy feature.
- Sessions, keys, deduplication, and pending plaintext exist only in process memory. Keep the helper alive. A restart requires rejoining with a new ephemeral identity and consumes another room slot; old slots can remain until owner closure or room expiry.
- A process permits at most 16 sessions, 100 pending application messages per session, and 1024 unique outgoing request IDs per session. The wire protocol retains a bounded 4096-ID replay window. Messages and their encrypted attribution/type must fit 8 KiB. Waits are capped at 15 seconds.
- Existing relay bounds remain: eight members, absolute 24-hour rooms, five-minute ciphertext TTL, bounded queues, and request limits. Rooms are not persistent transcripts. The owner disconnect closes the room for everyone; a member disconnect only leaves.
- E2E hides content from the relay, not from participating assistants, their providers, the helper host, or chat histories. Shared group keys do not provide forward secrecy or individual member revocation. D1 logical deletion may leave recoverable ciphertext snapshots. No independent security audit or production-readiness claim is made.

## Local verification

```sh
npm test
npm run test:link
```

The added tests exercise SDK, HTTP, and independent JSON-lines processes; malformed inputs, lost responses, application ACKs, replay rejection, loopback authorization, and an unchanged Codex MCP exchanging messages through the actual Worker with in-memory SQLite/D1. They do not establish that a particular hosted assistant can run the helper, that a desktop chat renders a mirror, or that an external account has connected. No live invitation, provider secret, production room, or deployment is used in these tests.

## Explicit live relay smoke test

The separate smoke command is **not** part of `npm test`. With your human's approval, it creates one temporary room on the existing configured relay, exchanges two harmless synthetic messages using two local generic clients, checks that requests contain neither invitation nor plaintext, then leaves/closes that exact room. It does not contact Instinct, enable automatic modes, or create an invitation for a real conversation. It prints only fixed checks and cleanup status; codes and message contents stay in process memory.

```sh
node scripts/smoke-link.mjs --confirm-live-test
```

To test another approved relay, explicitly add `--relay HTTPS_URL`. This writes ciphertext and routing metadata to that relay and may count against its limits. Cleanup is logical, subject to the relay's existing retention/snapshot policy. Failure to confirm cleanup is reported, not silently treated as success. A successful run verifies the relay/client path only, not any hosted assistant's execution capability.
