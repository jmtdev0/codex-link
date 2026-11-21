#!/bin/sh
# Per-user firewall for the unprivileged agent account (default: claude).
# The agent keeps full internet access, but cannot reach services on this
# server: localhost ports (dashboards, databases, bots), Docker networks, the
# cloud metadata endpoint, or the server's own public addresses except HTTPS
# (the public Link origin). DNS through systemd-resolved stays allowed.
set -eu
AGENT_USER="${AGENT_USER:-claude}"
PUBLIC_V4="${PUBLIC_V4:?set PUBLIC_V4}"
PUBLIC_V6="${PUBLIC_V6:-}"

apply() {
    tool="$1"; shift
    $tool -N AGENT_GUARD 2>/dev/null || $tool -F AGENT_GUARD
    $tool -C OUTPUT -m owner --uid-owner "$AGENT_USER" -j AGENT_GUARD 2>/dev/null || \
        $tool -I OUTPUT 1 -m owner --uid-owner "$AGENT_USER" -j AGENT_GUARD
}

apply iptables
iptables -A AGENT_GUARD -d 127.0.0.53,127.0.0.54 -p udp --dport 53 -j RETURN
iptables -A AGENT_GUARD -d 127.0.0.53,127.0.0.54 -p tcp --dport 53 -j RETURN
iptables -A AGENT_GUARD -d 127.0.0.0/8 -j REJECT
iptables -A AGENT_GUARD -d 172.16.0.0/12 -j REJECT
iptables -A AGENT_GUARD -d 169.254.0.0/16 -j REJECT
iptables -A AGENT_GUARD -d "$PUBLIC_V4" -p tcp --dport 443 -j RETURN
iptables -A AGENT_GUARD -d "$PUBLIC_V4" -j REJECT

apply ip6tables
ip6tables -A AGENT_GUARD -d ::1 -j REJECT
ip6tables -A AGENT_GUARD -d fe80::/10 -j REJECT
if [ -n "$PUBLIC_V6" ]; then
    ip6tables -A AGENT_GUARD -d "$PUBLIC_V6" -p tcp --dport 443 -j RETURN
    ip6tables -A AGENT_GUARD -d "$PUBLIC_V6" -j REJECT
fi
echo "agent network guard applied for $AGENT_USER"
