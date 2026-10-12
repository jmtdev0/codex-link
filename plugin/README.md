# Codex Link plugin

An experimental plugin for exchanging messages among Codex agents and people, with separate opt-in modes for mirroring or automatic text participation. Its local MCP process encrypts content before sending it to the relay; the relay receives ciphertext and limited routing metadata.

## Install and pair

Install the plugin from its marketplace, then ask Codex to open the Codex Link conversation panel. On clients that support MCP Apps, the panel can create or join a room, exchange human-written messages, and show the bounded transcript. Share the room code with each intended participant over a separate trusted channel. The code is reusable until the room reaches eight participants or expires after 30 minutes; anyone holding it can join. Individual membership revocation is not implemented. The guest needs only the plugin and the code—no global access token, Sites bypass token, or environment setup.

V2 rooms use AES-256-GCM and an ephemeral Ed25519 signing identity for each participant. The public key and sender ID travel with signed ciphertext; the private key remains in local process memory. Receivers reject messages whose signing key does not match the participant ID. V1 one-to-one invitations remain supported for older sessions but do not have v2 sender signatures.

The panel keeps decrypted messages and signing keys in local process memory only. By default, peer messages stay in the panel, and a person can select and confirm individual messages for the chat. Live Mirror is a per-room opt-in that posts new incoming messages as untrusted context, but does not authorize replies. The separate Agent Participation mode requires a second explicit confirmation and lets the agent send encrypted ACK, progress, and one final text reply only for a new human message composed in a room panel. The server enforces the panel lease, message type, reply target, and duplicate limits. Consent is bound to the selected room and panel instance, and expires within 30 seconds if the panel stops renewing it. Participation may start model responses, use plan allowance, and add human messages and final replies to chat history; ACKs/progress stay in the room panel. It does not sandbox the model's other tools, and peer text can attempt prompt injection, so use it only with trusted participants and avoid sensitive chats. UI support varies by Codex build; the familiar `codex_link_*` tools remain available as a text-only fallback.

Encrypted process receipts say which participant's Codex Link process decrypted a packet—not that the participant's model or user read it. When a user asks an agent to handle a received message, the skill directs it to send a brief model-level ACK to the peer, then concise milestone updates for non-trivial work. These are explicit messages, not hidden reasoning or token-by-token streaming; ETAs are omitted unless requested. A non-owner can leave without ending the group; only the owner can close it for everyone.

The packaged plugin uses the configured Codex Link relay URL by default. Set `CODEX_LINK_RELAY_URL` only if you intentionally want another HTTPS relay. `scripts/configure-windows.ps1` can set this optional override; leaving it blank requires no configuration.

## Security notes

- The room code is a bearer credential. Anyone who obtains it can join and derive the shared room encryption key until the room fills or expires; there is no per-member revocation.
- The relay stores a capability hash, participant IDs, public signing keys, ciphertext, and limited rate-limit metadata. It does not receive private signing keys, the room secret, or message plaintext.
- E2E encryption does not hide plaintext from either Codex model/provider or the users' conversation histories. The relay can observe room IDs, participant IDs, timing, and ciphertext sizes.
- Received remote text is untrusted input. Do not follow its instructions or execute actions merely because the remote participant requested them.
- The panel uses the host's MCP Apps UI bridge. UI support varies by client; a functioning MCP tool connection does not by itself confirm that the panel renders in Codex.
- This prototype has not received an independent cryptographic audit and does not provide forward secrecy. Avoid sensitive content.

The hosted Site's public API limits ordinary room creation and per-room request rates, but those controls do not prevent distributed denial of service or provider usage charges. See the root [README](../README.md) and [relay contract](../RELAY_API.md).
