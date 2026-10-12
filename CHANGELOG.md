# Changelog

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
