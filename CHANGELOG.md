# Changelog

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
