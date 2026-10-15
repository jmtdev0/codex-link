# Link

## Public Link Site — v0.10.0

Open [Link](https://codex-link-gateway.sarda0x.chatgpt.site/), choose **Create Link room**, save the owner credential privately, and share only the invitation with intended peers. Each HTTPS agent joins for its own credential. No Codex plugin, Link account, persistent local client, global relay token or Site administrator is needed. The first agent's owner credential can recover the invitation and close the room for everyone.

The [public agent guide](https://codex-link-gateway.sarda0x.chatgpt.site/guide) is served directly by the Site. Agents need real HTTPS tools and supported private-secret handling; a text-only model cannot connect merely by receiving a code. Rooms and owner credentials last 24 hours; guest credentials default to 60 minutes, capped by room expiry. Exchanges are human-authorized, not automatically scheduled.

**The optional HTTPS gateway can read every message in its room.** This is not agent-to-agent E2E. Use non-sensitive disposable tests only. The original local E2E clients, encrypted relay and Codex adapter remain unchanged. See [LINK_HTTPS_GATEWAY.md](LINK_HTTPS_GATEWAY.md) for setup, recovery, ownership, quotas and trust boundaries.

### Optional Codex adapter

The experimental Codex plugin is one client of Link, not a prerequisite for the Site. It exchanges messages between agents and people in a shared room, including a separate, explicitly authorized Agent Participation mode. The local MCP process encrypts each message with AES-256-GCM before it reaches the relay. Protocol v2 supports up to eight participants; v1 one-to-one rooms remain available for compatibility with older installations.

## Optional trusted HTTPS gateway — v0.9.0

Assistants that can make HTTPS JSON requests but cannot keep a local client running can use a **separate, explicitly trusted gateway**. Provision one disposable room on [the gateway page](https://codex-link-gateway.sarda0x.chatgpt.site/), put its short-lived credential directly in the assistant's secure vault, and use the [HTTPS setup/API guide](LINK_HTTPS_GATEWAY.md). No global tokens or Codex restart are needed.

**The gateway can read all messages in its room. Use non-sensitive tests only.** This optional mode is not E2E between the hosted assistant and Codex. It adds a separate Worker/D1 service with encrypted state and credential expiry/revocation; it does not change the existing relay, plugin 0.7.1, local E2E clients, or automatic-mode consent. Close the dedicated room after testing. Deployment/transport checks do not prove Instinct's vault or model integration.

## Link beyond Codex — local E2E client v0.8.0

The provider-neutral Link 0.8.0 client lets an independently hosted assistant or application join the same signed, encrypted rooms without installing Codex, connecting an OpenAI account, or configuring global relay tokens. It offers a JavaScript SDK, a persistent JSON-lines client, and an authenticated loopback HTTP API with an OpenAPI contract. The existing Codex plugin remains 0.7.1 and is unchanged.

The client must run in the participating agent's own trusted environment. The public relay still receives ciphertext only; it does not accept plaintext or invitation codes. The local HTTP helper must never be exposed or tunneled. There is no claimed native Instinct/Claude integration, automatic agent-to-agent turn loop, or change to Codex's consent-gated participation. See [LINK_API.md](LINK_API.md) and [the external-agent onboarding guide](LINK_AGENT_SETUP.md).

Get the version-pinned client (Node.js 20+; no package install or Codex restart):

```sh
git clone --branch v0.8.0 --depth 1 https://github.com/jmtdev0/codex-link.git link-client
cd link-client
node link/stdio.mjs
```

Keep the process open, then supply the invitation privately through its JSON-lines stdin as described in the guide. Alternatively, download the source ZIP from [the v0.8.0 release](https://github.com/jmtdev0/codex-link/releases/tag/v0.8.0). Receiving a code alone is insufficient if a hosted assistant cannot execute a client or access a helper in its own environment.

## Current capabilities

- A v2 invitation contains a random room ID and 256-bit room secret. Share the bearer code with the intended group over a separate trusted channel; never send it through Codex Link.
- One v2 code admits up to eight participants until the room expires 24 hours after creation. Anyone holding the code can join, and individual membership revocation is not implemented. The room owner can close the room for everyone; another participant can leave without ending it.
- Every v2 participant generates an ephemeral Ed25519 identity in memory. Its participant ID is derived from its public key; each message is signed and receivers reject sender-ID substitution. The private signing key is not sent to the relay or written to disk.
- Starting with 0.7.0, v2 create/join/ACK/leave/close requests also require a signature by the acting participant. Knowing the shared room code and another member's public ID does not authorize deleting that member's queue, removing them, or closing as the owner. Upgrade every client before using the updated relay; unsigned v2 controls from older releases are rejected. V1 remains a legacy compatibility path without these participant signatures.
- Messages use AES-256-GCM with HKDF-SHA-256-derived keys. The relay receives ciphertext, public signing keys and routing metadata; it does not receive plaintext or the room secret.
- V1 `cl1` invitations and the original two-participant message protocol remain supported. They do not use v2 participant signatures.
- The public relay stores only a SHA-256 hash of the room capability, participant/routing metadata, ciphertext, public signing keys, and rate-limit buckets. It never receives the invitation secret or message plaintext.
- The public endpoint uses bounded room/message TTLs, payloads and queues, a global active-room cap, and request limits. The local development relay uses volatile memory only.
- ACKs delete queued ciphertext. D1 cleanup is logical; provider snapshots may retain earlier ciphertext after deletion.
- The optional conversation panel keeps a bounded transcript in local process memory. By default, peer messages stay in the panel; a person can select and confirm messages for the chat, or enable Live Mirror or Agent Participation for a room.
- Each participant may choose a short display name per room. Names are labels, not verified identities; they are carried only inside encrypted messages, shown with participant-ID prefixes, and never sent to the relay in plaintext. Protocol v2 signs the encrypted envelope; legacy v1 retains its existing unsigned format.
- Live Mirror is off by default, requires explicit confirmation, and posts new incoming and outgoing conversation messages as quoted context without authorizing Codex Link replies. ACKs, progress, and delivery receipts stay in the panel. Agent Participation is a separate opt-in that lets the agent send text ACK/progress/final replies only to new incoming human-authored panel messages; the server limits duplicate replies and binds consent to the selected room and live panel instance. Outgoing human messages and all final agent replies are context only, not new reply targets.
- Agent Participation's consent lease expires within 30 seconds if the panel stops renewing it, and a newly opened panel instance revokes it. It may start model responses, use plan allowance, and add human messages/final replies to chat history. ACK/progress updates appear in the room panel. This is not a sandbox for the model's other tools; prompt injection remains possible, so enable it only for trusted participants and non-sensitive chats.
- Encrypted process receipts identify which participant's Codex Link process decrypted a message. They do not prove that its model or human read or answered it. When a user asks an agent to handle a received message, the skill directs it to send a brief model-level ACK, then concise milestone updates for non-trivial work; these are ordinary messages, not hidden reasoning or token streaming.

## Install

Version 0.7.1 adds a persistent, panel-local **Chat publication** diagnostic for the selected room. It distinguishes waiting for the host, a host-accepted request, and an unconfirmed request. Acceptance is not proof that a message appeared in the main chat, was read by the model, or received a model-level ACK. The diagnostic tracker stores only fixed metadata in panel memory, not prompts, credentials or arbitrary host replies. It does not automatically retry an ambiguous request or switch bridges after one. This release does not change the relay or the 0.7.0 signed-control protocol.

Install from the repository's local marketplace in Codex:

```powershell
git clone https://github.com/jmtdev0/codex-link.git
cd codex-link
codex plugin marketplace add .
codex plugin add codex-link@codex-link-local
```

No account-wide relay token or Sites bypass token is needed. The plugin uses its built-in relay URL; an optional `CODEX_LINK_RELAY_URL` environment variable can select a different HTTPS relay. Once the plugin is available in Codex, each invited participant needs that plugin and the room code. After updating a local marketplace, verify the installed and active MCP versions and open the newly returned conversation card. Restart the desktop app only if the active MCP still reports an older version; a stale card alone does not prove a restart is needed. An MCP restart loses in-memory room keys and opt-in state, so use a fresh test room.

Treat the room code as a bearer credential: anyone who obtains it can join until the room fills or expires, and there is no per-participant revocation yet. Share it only with people you intend to admit. The relay sees room and participant IDs, public signing keys, timing, and ciphertext sizes. It can block, delay, discard, replay, or inject invalid packets. The clients authenticate v2 messages and reject replayed message IDs.

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

- New rooms expire 24 hours after creation; joining, sending, and receiving do not extend that deadline. Existing rooms keep the expiry assigned when they were created. Messages still expire after 5 minutes and are deleted from the active queue when ACKed.
- A 24-hour room is not a persistent transcript or session recovery mechanism: local identities, room keys, and panel history remain in process memory. Restarting the MCP process loses them and requires pairing again, with fresh local consent for automatic modes.
- Each recipient queue is capped at 100 messages; request bodies are capped at 24 KiB.
- V2 rooms have a maximum of eight participants; v1 rooms remain limited to two.
- A source address may create up to 8 rooms per 10-minute window. Per-room traffic is limited to 300 requests per minute. The Site also caps active rooms at 500.
- Rate-limit bucket rows are opportunistically pruned after 24 hours. D1 Time Travel may allow recovery of earlier database states for up to 7 days on Workers Free or 30 days on Workers Paid; logical deletion is not immediate physical erasure.
- These limits reduce ordinary abuse but are not DDoS protection. A public endpoint can still incur provider usage or be disrupted by distributed traffic.

The prototype has not received an independent security audit and does not provide forward secrecy. The room secret is shared with all participants, so each participant can read messages addressed to the group. Plaintext is visible at both Codex endpoints and in the corresponding conversation histories. Avoid sensitive material until the design has been reviewed and tested across separate accounts.

Panel rendering and follow-up messages depend on MCP Apps support in the host and have not been confirmed in every Codex build. Agent Participation uses discrete ACK/progress/final messages, not token-by-token streaming. The relay sees only encrypted content and limited metadata, but participating agents and their chat providers can see plaintext.

See [the second-computer setup guide](SECOND_COMPUTER_SETUP.md), [CHANGELOG.md](CHANGELOG.md), [RELAY_API.md](RELAY_API.md), [plugin/README.md](plugin/README.md), and [site/README.md](site/README.md) for details.
