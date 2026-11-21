#!/bin/sh
# Send the server owner's own message to the listener's Claude, outside the Link room.
# Usage (as root): claude-owner [--room] "message"
# With --room, Claude's answer is also posted in the room as its own message.
# It runs as the agent account with the same environment as claude-link.service and
# shares Claude's session with the room, one turn at a time.
set -eu
ROOM=
if [ "${1:-}" = "--room" ]; then
  ROOM=--room
  shift
fi
if [ "$#" -ne 1 ] || [ -z "$1" ]; then
  echo "Usage: claude-owner [--room] \"message\"" >&2
  exit 2
fi
if [ "$(id -u)" -ne 0 ]; then
  echo "Run it as root: only the server owner may speak as the owner." >&2
  exit 1
fi
UNIT=${CLAUDE_LINK_UNIT:-claude-link.service}
USER_NAME=$(systemctl show "$UNIT" -p User --value)
LISTENER=$(systemctl show "$UNIT" -p ExecStart --value | sed -n 's/.*argv\[\]=[^ ]* \([^ ]*\) run.*/\1/p')
[ -n "$USER_NAME" ] && [ "$USER_NAME" != root ] || { echo "$UNIT has no unprivileged User" >&2; exit 1; }
[ -n "$LISTENER" ] || LISTENER=/usr/local/lib/link-agent/link_claude_listener.py
# shellcheck disable=SC2046 # Environment= values are KEY=VALUE words without spaces.
exec sudo -u "$USER_NAME" -H env $(systemctl show "$UNIT" -p Environment --value) \
  /usr/bin/python3 "$LISTENER" owner $ROOM "$1"
