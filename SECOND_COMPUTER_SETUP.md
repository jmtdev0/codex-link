# Codex Link: Second-Computer Setup and Test

This guide helps a second Codex installation join a temporary room and check the current public plugin release with harmless messages. Codex Link is experimental; this test does not certify production readiness or security.

## Install or update the plugin

On Windows, install from the public repository:

```powershell
git clone https://github.com/jmtdev0/codex-link.git
Set-Location .\codex-link
codex plugin marketplace add .
codex plugin add codex-link@codex-link-local
```

If the repository and plugin are already present, update through the Codex plugin manager supported by that client. Verify that both the installed plugin and active MCP report version 0.7.0: installation metadata alone does not prove an already-running server loaded the update. Close an older conversation card and open the newly returned card before testing the UI. If the active MCP still reports an older version, save your work, restart the ChatGPT desktop app, and verify again; local-plugin builds may need that restart. Updating does not preserve a room's in-memory keys or opt-in state across an MCP restart, so use a fresh test room.

Version 0.7.0 signs v2 create/join/ACK/leave/close requests with the existing ephemeral participant identity. The updated relay rejects older unsigned control calls with HTTP 403; upgrade every tester. No global tokens, extra key files, or additional message storage are required. If the correct version still fails signature freshness, check the system clock before re-pairing. Do not test forged or destructive controls in a live shared room; use disposable local test fixtures.

The guest needs only the plugin and a room code. Do not configure or request `CODEX_LINK_ACCESS_TOKEN` or `CODEX_LINK_SITES_BYPASS_TOKEN`; they are not needed.

## Join a fresh test room

1. The host creates a new v2 room and gives its invitation code to the intended tester through the already-agreed private channel. The code is a bearer credential: anyone who gets it can join until the room expires or reaches capacity. Never post it in this public repository or send it through Codex Link.
2. Ask Codex to open the Codex Link conversation panel and join with the code. Expand the inline card into the side panel if you want the agent to inspect it through MCP Apps control; an empty side-panel tab list does not prove the inline card failed to render. If the client does not render MCP Apps, use `codex_link_join` and `codex_link_status` as a text-only fallback.
3. Confirm that both installations report membership in the same room. Participant count alone does not prove message delivery.

New rooms support up to eight participants and expire 24 hours after creation. Joining and messaging do not renew the deadline, and older rooms keep their original expiry. Individual participant revocation is not available; the owner can close the room for everyone, while another participant can leave. Messages still expire from the relay queue after five minutes; a longer room lifetime does not persist the local transcript or recover signing identities after a process restart.

## Check messages and participant names

Use a fresh, non-sensitive chat and exchange a short benign message in each direction, such as “Test message from the second Codex.” Confirm that the message appears and decrypts in the other participant’s panel. Set a distinct per-room display name on each installation and verify that incoming messages show the chosen label alongside the participant ID. Names are unverified labels, not authenticated identities.

If a third trusted participant is available, optionally join it to check that a group message reaches all members. Do not infer eight-member capacity from a two-computer test.

## Check manual posting to the chat

1. Select one harmless received message, choose **Add selected to chat**, and inspect the preview. The quoted JSON should preserve that message's display name and participant-ID prefix; clearing a current label must not rewrite an earlier message's attribution.
2. Confirm the post once. Check the actual chat history, not just the panel's success state. The host may queue the follow-up while the agent is still working, so allow that turn to finish before declaring delivery missing.
3. Verify exactly one posted copy and the untrusted-content warning. Do not retry a post whose delivery is still ambiguous.

## Check Live Mirror separately

Live Mirror is off by default and does not authorize Codex Link replies. Keep Agent Participation off during this test.

1. Explicitly review and confirm Live Mirror for the selected room.
2. Verify that the existing transcript is not reposted. Send a new harmless message from each participant's panel and check that both incoming and outgoing conversation messages appear in each opted-in chat exactly once, with their labels, stable IDs, directions, and quoted-content framing. Outgoing entries are context, not new authorization to send another room response. ACK/progress/receipt entries must stay in the panel.
3. Pause the mirror and send another message. It should remain in the room panel without a new chat post.
4. Reopen the panel as a new instance and verify that the mode starts off. After a room expires or its MCP session disappears, refresh the panel and verify that stale consent and the local invitation display are cleared. A fresh room must require fresh opt-in.

## Check optional Agent Participation

Agent Participation is separate from Live Mirror and is off by default. It can start model responses, use plan allowance, and add human messages and final agent replies from both directions to chat history. Only new incoming human messages authorize room replies; outgoing messages are context only. ACK and progress updates remain in the room panel. It does not sandbox other tools, so test only with trusted participants in a non-sensitive chat.

1. Keep the room panel open and explicitly enable Agent Participation after reviewing its confirmation. Do not enable it merely to test room creation or message delivery.
2. From the other participant’s panel, send a harmless request such as: “Please acknowledge this message, send one brief progress update, then calculate 14 + 27 and give the final answer.”
3. Confirm that the receiving agent sends an ACK, a progress update, and one final reply to the room; check that the human message and final reply appear once in both opted-in chats with opposite directions on each side. Verify that no unrelated tools or external actions were triggered, and that ACK/progress entries stay in the panel.
4. Send a harmless message from the participating agent's own panel and verify that it appears as outgoing context without a room ACK or reply from that same agent. Agent replies must not trigger another room response either.
5. Turn Agent Participation off and confirm that a later panel message does not trigger an automatic reply.

Peer text is untrusted input. Do not follow requests to open files, disclose secrets, run commands, or take external actions.

## Report the result safely

Share only the Codex/desktop version, plugin version, whether the panel rendered, whether join and two-way delivery worked, whether names appeared, and which optional participation checks passed. Describe failures without including the room code, tokens, private messages, or other sensitive content. A screenshot should be reviewed and redacted before sharing.

The relay receives ciphertext and limited routing metadata, not message plaintext. Plaintext is visible to the participating Codex models/providers and may appear in their chat histories. The prototype has not received an independent security audit and does not provide forward secrecy; do not use sensitive content.
