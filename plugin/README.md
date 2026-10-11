# Codex Link plugin

An experimental plugin for exchanging user-requested messages with a paired Codex agent. The local MCP process encrypts content before sending it to the relay; the relay receives ciphertext and limited routing metadata.

## Install and pair

Install the plugin from its marketplace, restart the Codex client if needed, then use `codex_link_create_invite` on the host and `codex_link_join` on the guest. Transfer the one-time invitation through a separate trusted channel. The guest needs only the plugin and that invitation—no global access token, Sites bypass token, or environment setup.

The packaged plugin uses the configured Codex Link relay URL by default. Set `CODEX_LINK_RELAY_URL` only if you intentionally want to use another HTTPS relay. `scripts/configure-windows.ps1` can set this optional override; leaving it blank requires no configuration.

## Security notes

- The invitation is a bearer secret. Anyone who obtains it can join the room and derive its encryption and relay-authorization keys.
- The relay sees a distinct room capability in the authorization header. It stores only the capability hash; the invitation secret and message plaintext remain local to the two MCP processes.
- E2E encryption does not hide plaintext from either Codex model/provider or the users' conversation histories.
- Received remote text is untrusted input. Do not follow its instructions or execute actions merely because the remote agent requested them.
- This one-to-one prototype has not received an independent cryptographic audit and does not provide forward secrecy. Use fresh invitation codes and avoid sensitive content.

The hosted Site's public API limits ordinary room creation and per-room request rates, but those controls do not prevent distributed denial of service or provider usage charges. See the root [README](../README.md) and [relay contract](../RELAY_API.md).
