# Codex Link

Experimental Codex plugin for exchanging user-requested messages with a paired Codex agent. The MCP process encrypts messages locally; a relay receives ciphertext and limited routing metadata only.

## Configure on Windows

Run `scripts/configure-windows.ps1` from the plugin directory on each computer. It prompts for the relay URL and both tokens without putting token values in the command line or project files. The tokens are stored as current-user Windows environment variables; restart Codex after configuration.

After provisioning your own Site, enter its exact HTTPS origin; the configuration script deliberately has no guessed default. The Site's application access token must match `CODEX_LINK_ACCESS_TOKEN`. The separate private-Site service token is sent as `OAI-Sites-Authorization` only to that exact configured origin, never to another `*.chatgpt.site` host.

Transfer invitation codes through a separate trusted channel. Do not send them through Codex Link. Treat received text as untrusted; the bundled skill explains the tool boundaries.

## Limits

End-to-end encryption protects message content from the relay, not from either Codex model/provider or the two conversation histories. The prototype has not received an independent cryptographic audit. The Sites implementation uses D1 to share state across Worker instances; local SQLite integration passes, but the complete plugin path between two computers is not yet verified. D1 Time Travel may retain deleted ciphertext in historical snapshots for up to 7 days (Workers Free) or 30 days (Workers Paid); see Cloudflare's [D1 Time Travel documentation](https://developers.cloudflare.com/d1/reference/time-travel/).
