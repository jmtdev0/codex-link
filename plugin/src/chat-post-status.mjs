// Panel-local diagnostic metadata only: no prompts, room keys or raw host replies.
export function createChatPostStatusTracker() {
  const rooms = new Map();
  let nextAttempt = 0;
  return {
    begin(sessionId, { source = "manual", channel = "ui/message" } = {}) {
      const id = String(sessionId || "");
      if (!id) throw new TypeError("A local room session is required.");
      const attemptId = ++nextAttempt;
      rooms.set(id, {
        attemptId,
        source: ["manual", "mirror", "participate"].includes(source) ? source : "manual",
        channel: ["ui/message", "compatibility"].includes(channel) ? channel : "unsupported",
        state: "pending",
        reason: "",
      });
      return { sessionId: id, attemptId };
    },
    finish(attempt, error = null) {
      const record = rooms.get(attempt?.sessionId);
      if (!record || record.attemptId !== attempt.attemptId) return false;
      // Never retain or display an arbitrary host error, which could contain text or secrets.
      const reason = !error ? ""
        : error.code === -32601 ? "method-unavailable"
          : error.code === -32602 ? "invalid-parameters"
            : ["timeout", "declined", "unsupported", "malformed"].includes(error.kind) ? error.kind
              : "host-error";
      rooms.set(attempt.sessionId, { ...record, state: error ? "unconfirmed" : "accepted", reason });
      return true;
    },
    get(sessionId) {
      const record = rooms.get(String(sessionId || ""));
      return record ? { ...record } : null;
    },
    synchronizeSessions(sessionIds = []) {
      const active = new Set(sessionIds.map(String));
      for (const id of rooms.keys()) if (!active.has(id)) rooms.delete(id);
    },
    describe(sessionId) {
      const record = rooms.get(String(sessionId || ""));
      if (!record) return "Chat publication: no attempt observed in this panel for this room yet.";
      const source = ({ manual: "manual selection", mirror: "Live Mirror", participate: "Agent Participation" })[record.source];
      const route = record.channel === "compatibility" ? "host compatibility bridge" : record.channel;
      const prefix = `Chat publication (${source}, ${route}): `;
      if (record.state === "pending") return `${prefix}waiting for the host response.`;
      if (record.state === "accepted") return `${prefix}the host accepted the request. Appearance in the main chat is not verified; this is not a reading receipt.`;
      const reason = ({
        "method-unavailable": "the host does not expose this message method (-32601)",
        "invalid-parameters": "the host rejected the message parameters (-32602)",
        timeout: "the host response timed out",
        declined: "the host declined the request",
        unsupported: "this host does not support posting from the panel",
        malformed: "the host response was malformed",
        "host-error": "the host returned an error",
      })[record.reason];
      return `${prefix}not confirmed because ${reason}. Do not automatically resend: a chat post may already exist.`;
    },
  };
}
