import { LINK_API_VERSION, LINK_CLIENT_VERSION } from "./client.mjs";
import { LinkError, fields } from "./errors.mjs";

export async function dispatch(client, method, params = {}) {
  switch (method) {
    case "info":
      fields(params, []);
      return { apiVersion: LINK_API_VERSION, clientVersion: LINK_CLIENT_VERSION, relayUrl: client.relayUrl,
        methods: ["info", "create", "join", "status", "send", "receive", "ack", "disconnect"],
        protocolVersion: 2, automaticAgentParticipation: false };
    case "create": return client.createRoom(params);
    case "join": return client.joinRoom(params);
    case "status":
    case "disconnect":
      fields(params, ["sessionId"], ["sessionId"]);
      return method === "status" ? client.status(params.sessionId) : client.disconnect(params.sessionId);
    case "send": {
      fields(params, ["sessionId", "text", "requestId", "messageType", "inReplyTo"], ["sessionId", "text", "requestId"]);
      const { sessionId, ...options } = params;
      return client.send(sessionId, options);
    }
    case "receive": {
      fields(params, ["sessionId", "waitMs"], ["sessionId"]);
      const { sessionId, ...options } = params;
      return client.receive(sessionId, options);
    }
    case "ack":
      fields(params, ["sessionId", "messageIds"], ["sessionId", "messageIds"]);
      return client.acknowledge(params.sessionId, { messageIds: params.messageIds });
    default: throw new LinkError("METHOD_NOT_FOUND", "Unknown Link method.", 404);
  }
}
