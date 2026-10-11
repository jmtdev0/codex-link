# Changelog

## 0.3.0 — Conversation panel and delivery receipts

- Add an MCP Apps conversation panel for creating/joining rooms, sending human-written messages, polling for incoming messages, and viewing up to 100 recent messages per local room.
- Keep invitation codes and decrypted panel transcripts in panel-only MCP result metadata; do not add peer messages to the model conversation unless a person selects them and confirms.
- Add encrypted process-level receipts after successful local decryption. A receipt indicates only that the peer's Codex Link process decrypted a message; it does not prove that the peer's model or user read it.
- Always erase local room keys and transcripts when a user disconnects, even if the relay is unavailable or the peer already closed the room; report whether the relay confirmed room closure.
- Keep the existing one-to-one room protocol, text tools, and public relay. Multi-agent group rooms and true model-streaming progress remain future work.
- Panel UI rendering depends on MCP Apps support in the host. Codex tool compatibility is not proof that a particular Codex build renders the panel.
- Verify with `node --test tests/*.test.mjs` (21 tests).
