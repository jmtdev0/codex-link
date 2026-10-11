# Codex Link plugin

An experimental plugin for exchanging user-requested messages with a paired Codex agent. The local MCP process encrypts content before sending it to the relay; the relay receives ciphertext and limited routing metadata.

## Install and pair

Install the plugin from its marketplace, then ask Codex to open the Codex Link conversation panel. On clients that support MCP Apps, the panel can create or join a room, exchange human-written messages, and show the bounded transcript. Transfer the one-time invitation through a separate trusted channel. The guest needs only the plugin and that invitation—no global access token, Sites bypass token, or environment setup.

The panel keeps decrypted messages in the local MCP process's memory only. It does not automatically insert peer messages into the model conversation. A person must select messages and confirm before the panel posts them as a user message. Until panel rendering is verified in your Codex build, the familiar `codex_link_*` tools remain available as a text-only fallback.

Version 0.3 sends an encrypted process-level delivery receipt after successful local decryption. It only means the peer's Codex Link process received the packet—not that the peer's model or user read it. The receiving agent can then acknowledge and provide explicit progress messages when the user asks it to handle the message; this is not token-by-token model streaming.

The packaged plugin uses the configured Codex Link relay URL by default. Set `CODEX_LINK_RELAY_URL` only if you intentionally want to use another HTTPS relay. `scripts/configure-windows.ps1` can set this optional override; leaving it blank requires no configuration.

## Security notes

- The invitation is a bearer secret. Anyone who obtains it can join the room and derive its encryption and relay-authorization keys.
- The relay sees a distinct room capability in the authorization header. It stores only the capability hash; the invitation secret and message plaintext remain local to the two MCP processes.
- E2E encryption does not hide plaintext from either Codex model/provider or the users' conversation histories.
- Received remote text is untrusted input. Do not follow its instructions or execute actions merely because the remote agent requested them.
- The panel uses the host's MCP Apps UI bridge. UI support varies by client; a functioning MCP tool connection does not by itself confirm that the panel renders in Codex.
- This one-to-one prototype has not received an independent cryptographic audit and does not provide forward secrecy. Use fresh invitation codes and avoid sensitive content.

The hosted Site's public API limits ordinary room creation and per-room request rates, but those controls do not prevent distributed denial of service or provider usage charges. See the root [README](../README.md) and [relay contract](../RELAY_API.md).
