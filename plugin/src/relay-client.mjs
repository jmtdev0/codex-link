const DEFAULT_RELAY_URL = "https://codex-link-relay.sarda0x.chatgpt.site";

function endpoint(baseUrl, path) {
  const normalized = new URL(baseUrl);
  if (!new Set(["http:", "https:"]).has(normalized.protocol)) {
    throw new Error("Relay URL must use HTTP or HTTPS.");
  }
  normalized.pathname = `${normalized.pathname.replace(/\/$/, "")}${path}`;
  normalized.search = "";
  normalized.hash = "";
  return normalized;
}

async function request(baseUrl, path, { method = "GET", body, query, roomCapability } = {}) {
  const url = endpoint(baseUrl, path);
  if (query) {
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
  }
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (typeof roomCapability !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(roomCapability)) {
    throw new Error("A valid room capability is required for relay requests.");
  }
  headers.authorization = `Bearer ${roomCapability}`;

  const timeoutMs = method === "GET" && query?.waitMs ? Number(query.waitMs) + 2_000 : 10_000;
  const response = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(Math.min(Math.max(timeoutMs, 2_000), 20_000)),
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`Relay returned an invalid response (HTTP ${response.status}).`);
  }
  if (!response.ok) {
    const safeMessage = typeof payload?.error === "string" ? payload.error : `HTTP ${response.status}`;
    throw new Error(`Relay request failed: ${safeMessage}`);
  }
  return payload;
}

export function relayBaseUrl() {
  const value = process.env.CODEX_LINK_RELAY_URL?.trim() || DEFAULT_RELAY_URL;
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Relay URL must not contain credentials, query parameters, or a fragment.");
  }
  const isLoopback = new Set(["localhost", "127.0.0.1", "[::1]"]).has(url.hostname);
  if (!isLoopback && url.protocol !== "https:") {
    throw new Error("Non-local relays must use HTTPS.");
  }
  return url.toString().replace(/\/$/, "");
}

export function createRoom(baseUrl, roomId, participantId, roomCapability) {
  return request(baseUrl, "/v1/rooms", { method: "POST", body: { roomId, participantId }, roomCapability });
}

export function joinRoom(baseUrl, roomId, participantId, roomCapability) {
  return request(baseUrl, `/v1/rooms/${encodeURIComponent(roomId)}/join`, {
    method: "POST",
    body: { participantId },
    roomCapability,
  });
}

export function getRoomStatus(baseUrl, roomId, participantId, roomCapability) {
  return request(baseUrl, `/v1/rooms/${encodeURIComponent(roomId)}/status`, {
    query: { participantId },
    roomCapability,
  });
}

export function sendEnvelope(baseUrl, envelope, roomCapability) {
  return request(baseUrl, `/v1/rooms/${encodeURIComponent(envelope.roomId)}/messages`, {
    method: "POST",
    body: envelope,
    roomCapability,
  });
}

export function receiveEnvelopes(baseUrl, roomId, participantId, roomCapability, waitMs = 0) {
  return request(baseUrl, `/v1/rooms/${encodeURIComponent(roomId)}/messages`, {
    query: { participantId, waitMs },
    roomCapability,
  });
}

export function acknowledgeEnvelopes(baseUrl, roomId, participantId, messageIds, roomCapability) {
  return request(baseUrl, `/v1/rooms/${encodeURIComponent(roomId)}/acks`, {
    method: "POST",
    body: { participantId, messageIds },
    roomCapability,
  });
}

export function closeRoom(baseUrl, roomId, participantId, roomCapability) {
  return request(baseUrl, `/v1/rooms/${encodeURIComponent(roomId)}`, {
    method: "DELETE",
    body: { participantId },
    roomCapability,
  });
}
