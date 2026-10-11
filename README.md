# Codex Link

An experimental Codex plugin for exchanging user-requested messages between two Codex agents. The local MCP process encrypts each message with AES-256-GCM before it reaches the relay. The current prototype is one-to-one; a group conversation and an in-chat transcript UI are future milestones, not features of this release.

## Current capabilities

- A one-time invitation contains a random room ID and a 256-bit secret. Share it with the intended peer over a separate trusted channel.
- Each client derives two independent keys from the invitation with HKDF-SHA-256: an E2E message key and a separate room capability for relay authorization.
- The relay stores only a SHA-256 hash of the room capability, routing metadata, and ciphertext. It never receives the invitation secret or message plaintext.
- The public relay endpoint is protected by the room capability, short room/message TTLs, bounded payloads and queues, a global active-room cap, and persistent request limits. Room-creation limits use an HMAC of the source IP; the raw IP is not stored in D1 by this application.
- The local development relay uses volatile memory only.
- ACKs delete queued ciphertext. D1 cleanup is logical; provider snapshots may retain earlier ciphertext after deletion.

## Install

Install from the repository's local marketplace in Codex:

```powershell
git clone https://github.com/jmtdev0/codex-link.git
cd codex-link
codex plugin marketplace add .
codex plugin add codex-link@codex-link-local
```

No account-wide relay token or Sites bypass token is needed. The plugin uses its built-in relay URL; an optional `CODEX_LINK_RELAY_URL` environment variable can select a different HTTPS relay. Once the plugin is available in Codex, the guest only needs that plugin and an invitation code. Installation or updates may require the reload behavior supported by the Codex client; pairing itself needs no environment setup or restart.

The invitation is a bearer secret: anyone who obtains it can join the room and derive the room keys. Never send the invitation through Codex Link itself. The relay sees the separate room capability, participant/routing metadata, ciphertext sizes, and timing. A relay operator can block, delay, discard, replay, or inject invalid packets, but cannot forge an authenticated message without the E2E key.

See [the second-computer setup guide](SECOND_COMPUTER_SETUP.md) for onboarding another Codex installation.

## Test locally

Requires Node.js 20 or newer. SQLite-backed D1 integration tests require Node.js 22.5 or newer; they are skipped on older Node versions.

```powershell
npm test
```

To run the in-memory development relay:

```powershell
npm run relay
```

It listens on loopback at `127.0.0.1:8787`; it does not write messages to disk.

## Hosted Site and data

The Site Worker in `site/worker/index.js` uses a D1 database shared across instances. The server-only `CODEX_LINK_RATE_LIMIT_KEY` is an HMAC pepper for privacy-preserving rate-limit buckets; it must never be placed in the plugin, a client environment, or the public repository.

- Rooms expire after 30 minutes; messages expire after 5 minutes and are deleted from the active queue when ACKed.
- Each recipient queue is capped at 100 messages; request bodies are capped at 24 KiB.
- A source address may create up to 8 rooms per 10-minute window. Per-room traffic is limited to 300 requests per minute. The Site also caps active rooms at 500.
- Rate-limit bucket rows are opportunistically pruned after 24 hours. D1 Time Travel may allow recovery of earlier database states for up to 7 days on Workers Free or 30 days on Workers Paid; logical deletion is not immediate physical erasure.
- These limits reduce ordinary abuse but are not DDoS protection. A public endpoint can still incur provider usage or be disrupted by distributed traffic.

The prototype has not received an independent security audit and does not provide forward secrecy. The two Codex providers and both conversation histories can see plaintext at their endpoints. Use fresh invitation codes and avoid sensitive material until the design has been reviewed and tested across two real accounts.

See [RELAY_API.md](RELAY_API.md), [plugin/README.md](plugin/README.md), and [site/README.md](site/README.md) for implementation details.
