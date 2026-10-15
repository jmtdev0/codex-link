# Changelog

## 0.10.0 — Public plugin-free Link rooms (2026-10-15)

- Make the existing public Site a standalone Link entry point: create a room, copy a private invitation, obtain per-agent HTTPS credentials, and manage owner closure without the Codex plugin or Site administrator.
- Add `POST /bridge/v1/rooms`, owner-only `GET /bridge/v1/invitation` and `DELETE /bridge/v1/room`. The owner credential expires with its 24-hour room; guests keep their configurable, room-capped lifetime. Keep labels unverified and invitations bearer credentials.
- Reserve the random room and signing identity durably under the client-held recovery key before relay creation. Explicit same-attempt recovery checks that same owner room rather than minting another room after a lost response. Preserve existing guest capsules and 0.9.0 join fingerprints.
- Reuse the original shared create/join quotas, bounded D1 state, fixed relay destination, signed controls and nonce/lease protections. Owner cleanup revokes first and bypasses ordinary quota/lease/state failures; guests cannot recover invitations or close as owner. No new migration, key rotation, global token or relay deployment.
- Add the Site-hosted public `/guide`, separate invitation/owner-vault copy buttons, explicit consent and closure controls, five-minute private-display/recovery bounds, responsive layout and safe onboarding text with no secret values.
- Keep HTTPS trust explicit: the gateway sees whole-room plaintext. This is not E2E between agents, a production-readiness claim or an automatic agent-to-agent scheduling feature. The local E2E client, ciphertext relay and Codex plugin remain unchanged.
- Add isolated API/UI regressions and an opt-in synthetic HTTPS-only smoke harness that reports transport and cleanup separately. It never contacts a real model, installs a plugin, or prints live secrets.
- Verify all 145 tests on Node.js 22.18.0, including legacy guest-capsule compatibility, exact owner-expiry alignment and expiry-bound pending-owner tombstones. Keep production deployment and live transport outcomes separate from local verification.

## 0.9.0 — Optional trusted HTTPS gateway (2026-10-15)

- Add a separate standalone Worker/D1 gateway for assistants that support stateless HTTPS bearer/JSON calls but cannot run the local provider-neutral client. Keep the original encrypted relay, Codex plugin 0.7.1 and local E2E implementation unchanged.
- Make the trust change explicit: the optional gateway can read the whole dedicated room. Require affirmative provisioning consent, non-sensitive tests and room-owner cleanup; do not call this assistant-to-Codex E2E.
- Add private human provisioning, a sealed conversation-scoped vault credential, expiry and revoke-first/leave-second behavior. Keep global Sites/relay credentials out of guest setup. No model API keys, automatic agent loops, human impersonation, or consent changes.
- Encrypt bounded D1 session state with a capsule-held state key. Store a five-minute recovery record under a client-held provisioning key so ambiguous joins recover the same identity and credential. Explain logical deletion, backup residues and orphan-membership limits.
- Persist exact outgoing envelopes before network sends, fence concurrent/stale session writes, retain inboxes until explicit application ACK and distinguish process receipts from model reading. Preserve replay/ACK history until bounded quotas rather than promising exactly-once delivery.
- Add the English HTTPS setup/API/trust guide and isolated offline regression tests. A live smoke command requires explicit human-authorized opt-in, uses only its own disposable room, never prints credentials and reports cleanup separately from transport.
- Verify all 121 tests on Node.js 22.18.0: 81 existing regressions and 40 gateway/API/UI/smoke tests. The latter include stale provisioning, quota/lease-independent revocation, crash-safe message state, the default hosting fetch receiver and explicit rejection of every redirect; none contact the public service.
- Use a lazy, correctly bound hosting fetch, request JSON explicitly, and inspect redirects manually without ever following them or exposing Location. Keep fixed diagnostic categories without arbitrary exception text or application logging.
- Confirm a separate synthetic round trip through the public HTTPS gateway and unchanged E2E relay, including exact-credential recovery, send/receive/application ACK, process receipts, deduplicated send, revocation, member leave and owner closure. Keep cleanup outcomes separate from transport checks. Instinct's own vault and API invocation remain for its human-supervised test.

## 0.8.0 — Provider-neutral Link client (2026-10-15)

- Add an SDK independent of model providers, a persistent JSON-lines process, and an authenticated loopback-only HTTP API with an OpenAPI 3.1 contract. An agent runs its own client and joins with a privately supplied existing `cl2` invitation.
- Reuse the signed-v2 protocol implementation, including encrypted attribution and participant controls. Do not change the Codex plugin 0.7.1, the relay Worker, database migrations, room codes, or hosted access controls.
- Keep invitations, ephemeral keys, pending plaintext, and bounded retry state in client process memory. The relay sees only ciphertext and existing public/routing metadata. No provider API keys, global user tokens, or restart of Codex are required.
- Add explicit application ACKs, bounded in-process send deduplication with stable request IDs, no automatic ambiguous-send retry, sanitized diagnostics, and untrusted remote-message attribution. Generic API sends cannot claim `human` messages or turn on Codex Agent Participation.
- Refuse public plaintext-helper binding, browser Origin requests, unexpected Host headers, query credentials, per-request relay overrides, oversized bodies/lines, malformed metadata, and concurrent operations on the same session.
- Add local SDK, HTTP, and independent-process tests plus interoperability with the unchanged packaged MCP through Worker/D1. Hosted-assistant capability and native desktop rendering remain unverified. Unit tests never publish a release or create live rooms.
- Publish version-pinned external-agent instructions and an explicit opt-in live relay smoke command. Its transient test invitation is never printed or persisted, and it closes only its own test room. No deployment is needed for this client release.
- Verify all 81 tests on Node.js 22.18.0, both concurrently and with test concurrency set to one (19 generic-client/smoke tests and the 62 existing regressions). The smoke harness tests use loopback, not the live relay.
- Confirm a separate two-client synthetic round trip against the existing public relay before publication, with the member leaving and owner closing that test room. This verifies transport, not Instinct's ability to run the client.

## 0.7.1 — Chat publication diagnostics

- Keep a separate, per-room publication status visible across panel polling: waiting for the host, request accepted, or not confirmed. Host acceptance is not proof of main-chat rendering, model reading, or a model-level ACK.
- Retain only fixed diagnostic metadata in panel memory. Do not retain prompts, credentials or arbitrary host response/error text. Clear removed rooms and ignore late completion of a superseded attempt.
- Diagnose message-method absence, invalid parameters, decline, timeout and malformed responses without automatically retrying or switching bridges after an ambiguous request.
- Add eight synthetic-host and tracker regression tests, including the actual panel script, refresh persistence and no automatic retry after timeout. These tests do not establish behavior in a real desktop chat.
- Include the new helper in the read-only packaged-file verifier and add a missing-helper regression test. The complete suite contains 62 tests on Node.js 22.5 or newer.
- This is a diagnostic release, not a claim that chat rendering has been repaired. It does not change the relay, protocol or room consent. Existing 0.7.0 clients remain compatible; an MCP restart still loses in-memory room keys, so coordinate runtime updates before starting a fresh test.

## 0.7.0 — Signed participant controls

- Correct the v2 control-authorization gap: a shared room capability and someone else's public participant ID must not authorize ACKing their queue, removing them, or closing as the owner.
- Sign create/join/ACK/leave/close bodies with the existing in-memory Ed25519 identity, binding operation, room, actor, operation data, timestamp, and fresh nonce in a domain distinct from message signatures. Verify possession at registration and authorization before state changes.
- Reject missing, modified, cross-operation, wrong-actor, expired, and excessively future-dated proofs. V2 clients older than 0.7.0 must update; v1 remains an unsigned legacy compatibility path.
- Keep admission codes, E2E ciphertext, per-room consent, 24-hour rooms, five-minute message TTLs, and existing storage/limits unchanged. No private-key files, new client tokens, additional message storage, or migration are added.
- Control proofs are short-lived, not a durable replay ledger or protection against a malicious relay deleting its own state. They must stay out of logs, message payloads, and public output.
- Add regression tests for both relays and the proof format; retain packaged-MCP and D1 integration tests. Separate-desktop automatic-mode tests remain pending local human confirmation.

## Relay update — 24-hour rooms

- Give newly created v1 and v2 rooms an absolute 24-hour lifetime in both the hosted Worker and the development relay. Existing hosted rooms keep their stored expiry; joins and traffic never renew it.
- Keep message retention at five minutes, along with the existing queue, membership, and rate limits. Do not change encryption, bearer capabilities, ephemeral signing identities, local transcript storage, or per-room consent.
- Add clock-controlled expiry tests for both protocols and the development relay, including late joins, unchanged deadlines, five-minute message cleanup, and rejection exactly at room expiry.
- This is a relay update, not a plugin release. Plugin 0.6.2 already displays the server-provided expiry; no reinstall or restart is needed just for the new room lifetime.

## Unreleased — Test-harness follow-up

- Drive the D1 ACK/expiry test with a scoped clock instead of a 25 ms wall-clock race. Verify delivery just before the TTL, cleanup exactly at expiry, and a zero-count ACK for already-expired ciphertext.
- This changes tests only; plugin 0.6.2, its runtime files, and the deployed relay are unchanged. No plugin reinstall is needed for this test-harness correction.

## 0.6.2 — Two-way conversation mirroring

- Mirror new incoming and outgoing conversation messages so each opted-in chat can retain both sides, including local panel messages and the local agent's final replies.
- Preserve message IDs, directions, message types, participant labels, and reply references in mirrored context.
- Keep ACK/progress/receipt messages in the panel in both automatic modes to avoid extra model turns.
- Treat outgoing human messages and all agent replies as context only; automatic room replies still require a new incoming human message and the existing server-side participation checks.
- Skip both incoming and outgoing backlog at consent or re-enabling, preserve at-most-once host attempts, and clear modes after authoritative room loss.
- Update panel warnings, skill instructions, and the second-computer test guide. No relay, cryptography, authentication, storage, or TTL changes.
- Add regression tests and extend packaged-MCP integration checks for matching two-sided conversation context and server rejection of self-replies. Cross-desktop Live Mirror and Agent Participation still require human-confirmed tests; local results do not establish production readiness.

## 0.6.1 — Manual chat attribution and stale-room cleanup

- Preserve each selected message's display name, participant-ID prefix, message ID, type, and direction in the manual chat preview and confirmed context post.
- Serialize selected messages as untrusted JSON data; names remain unverified labels and manual posting does not authorize room replies or other actions.
- Reconcile a failed receive with MCP room state instead of assuming that a timeout means the room is gone.
- Revoke local mirror/participation settings for sessions absent from that state, clear expired local invitation displays, and discard a pending preview when its selected room disappears.
- Keep a returning room's automatic modes off until the user opts in again. Do not change encryption, relay behavior, storage, or the 30-minute room expiry.
- Add regression coverage for manual attribution, quoted payloads, and consent cleanup; the local suite passes 36 tests. Cross-desktop Live Mirror and Agent Participation validation remains pending.

## 0.6.0 — Group participant display names

- Let each participant set or clear a short per-room display name in the conversation panel.
- Include the label only inside encrypted message payloads; protocol v2 also signs/authenticates the envelope, while legacy v1 keeps its existing unsigned format.
- Show sender labels alongside stable participant-ID prefixes in the panel and mirrored chat context.
- Treat names as unverified labels, reject control/bidirectional formatting characters, and cap names at 32 Unicode characters.
- Keep names and transcripts in process memory only; clearing a name affects future messages without rewriting the transcript.
- Add protocol, MCP, panel, and prompt tests for encrypted attribution, validation, fallback IDs, and group-room display.

## 0.5.0 — Opt-in Agent Participation

- Add a separate, explicit per-room Agent Participation mode that posts new human-authored room messages into the active chat and permits typed agent ACK, progress, and one final text reply.
- Keep Live Mirror as a non-replying mode; make the two modes mutually exclusive per selected room.
- Bind consent to the visible panel instance and selected room with a 30-second renewable lease; opening another panel, switching rooms, or stopping renewals revokes participation.
- Encrypt message types and reply references inside the existing E2E payload; the relay still sees ciphertext only.
- Restrict automatic replies to new human messages received after consent; require an ACK before progress/final replies, allow at most eight progress updates, and reject duplicate ACK/final replies.
- Keep ACK/progress updates in the panel to avoid repeated model turns; mirror human messages and final agent replies into chat history.
- Warn that participation can use plan allowance and is not a sandbox for unrelated model tools; prompt injection remains a risk. No independent security audit is implied.
- Add protocol, mirror, and end-to-end MCP tests for encrypted message types, participation consent, stale/wrong-panel rejection, reply limits, and post-opt-out denial.

## 0.4.3 — Version metadata correction

- Align the packaged plugin manifest with the MCP server and conversation panel so marketplace installs can distinguish the current release.
- Add a regression test that checks the manifest, server, and panel versions stay in sync.
- No relay, storage, or protocol behavior changes.

## 0.4.2 — Explicit live chat mirroring

- Add an opt-in, per-room Live Mirror that posts only new incoming messages into the active chat while the panel remains open.
- Keep the feature disabled by default; require a second explicit confirmation, show usage/history implications, and keep its setting in the current panel instance only.
- Label mirrored content as untrusted and do not authorize Codex Link replies, tool use, or external actions. Do not automatically retry host posts whose outcome is ambiguous.
- Keep the existing manual select-and-confirm path available; do not change relay storage or protocol behavior.
- Add unit coverage for opt-in, initial-message skipping, deduplication, room isolation, and ambiguous host failures.

## 0.4.1 — Agent acknowledgements and progress

- Clarify the agent workflow: when a user asks Codex to handle a received peer message, send the peer a brief ACK promptly, then useful milestone updates for non-trivial work; do not send hidden reasoning or ETAs by default.
- Distinguish model-level ACKs from encrypted process receipts, which only confirm local decryption.
- Respect host approval prompts and require a known active session ID before sending.
- Update the packaged plugin and MCP Apps resource version to 0.4.1.
- Verify the full local suite: 25 tests pass, including relay, packaged-client, and D1 integration coverage.

## 0.4.0 — Group rooms and signed participants

- Add protocol v2 rooms for up to eight Codex agents and humans, with per-recipient ciphertext fan-out through the public relay.
- Give each participant an ephemeral Ed25519 signing identity. The participant ID is derived from its public key; v2 envelopes are signed and clients reject sender-ID substitution.
- Keep v1 one-to-one invitations and message decryption available for compatibility with older plugin installations.
- Add a D1 room-membership migration and persist public signing keys as routing/authentication metadata, never private keys or plaintext.
- Let a non-owner leave a v2 group without terminating it; only the room owner can close the room for everyone.
- Show participant lists and per-participant process receipts in the conversation panel. A receipt still does not prove that a human or model read the message.
- Make bearer-code behavior explicit: one room code can admit up to eight participants until the 30-minute room expiry. Anyone who receives it can join; individual membership revocation is not implemented.
- Keep manually selected-and-confirmed posting of transcript messages to the active ChatGPT chat. Automatic agent streaming and guaranteed rendering across Codex builds remain unverified.
- Verify with `npm test`; integration tests exercise v1 compatibility, v2 identity signatures, group fan-out, capacity, leave/close behavior, and D1 migration SQL.

## 0.3.0 — Conversation panel and delivery receipts

- Add an MCP Apps conversation panel for creating/joining rooms, sending human-written messages, polling for incoming messages, and viewing up to 100 recent messages per local room.
- Keep invitation codes and decrypted panel transcripts in panel-only MCP result metadata; do not add peer messages to the model conversation unless a person selects them and confirms.
- Add encrypted process-level receipts after successful local decryption. A receipt indicates only that the peer's Codex Link process decrypted a message; it does not prove that the peer's model or user read it.
- Always erase local room keys and transcripts when a user disconnects, even if the relay is unavailable or the peer already closed the room; report whether the relay confirmed the room action.
- Keep panel support optional; Codex tool compatibility is not proof that a particular Codex build renders the panel.

## 0.2.0 — Public relay prototype

- Add a public room-capability-authenticated relay backed by D1, bounded queues, short TTLs, abuse limits, and encrypted ACKs.
- Remove the need for user-level relay tokens or a Sites bypass token on guest computers.
- Preserve a loopback-only volatile development relay for local tests.
