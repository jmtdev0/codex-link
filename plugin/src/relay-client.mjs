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

async function request(baseUrl, path, { method = "GET", body, query } = {}) {
  const url = endpoint(baseUrl, path);
  if (query) {
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
  }
  const headers = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  const accessToken = process.env.CODEX_LINK_ACCESS_TOKEN;
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  if (url.hostname.toLowerCase().endsWith(".chatgpt.site")) {
    if (url.origin !== configuredSitesOrigin()) {
      throw new Error("The private Sites token is restricted to the exact configured relay origin.");
    }
    const sitesToken = process.env.CODEX_LINK_SITES_BYPASS_TOKEN?.trim();
    if (!sitesToken) {
      throw new Error("Set CODEX_LINK_SITES_BYPASS_TOKEN before using a private ChatGPT Site relay.");
    }
    headers["OAI-Sites-Authorization"] = `Bearer ${sitesToken}`;
  }

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

function configuredSitesOrigin() {
  const value = process.env.CODEX_LINK_SITES_ALLOWED_ORIGIN?.trim();
  if (!value) {
    throw new Error("Set CODEX_LINK_SITES_ALLOWED_ORIGIN to the exact private Site origin.");
  }
  let origin;
  try {
    origin = new URL(value);
  } catch {
    throw new Error("CODEX_LINK_SITES_ALLOWED_ORIGIN must be a valid HTTPS Site origin.");
  }
  if (
    origin.protocol !== "https:" ||
    !origin.hostname.toLowerCase().endsWith(".chatgpt.site") ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== "/"
  ) {
    throw new Error("CODEX_LINK_SITES_ALLOWED_ORIGIN must be the exact HTTPS origin of a private *.chatgpt.site relay.");
  }
  return origin.origin;
}

export function relayBaseUrl() {
  const value = process.env.CODEX_LINK_RELAY_URL?.trim();
  if (!value) throw new Error("Set CODEX_LINK_RELAY_URL to a relay endpoint before using Codex Link.");
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Relay URL must not contain credentials, query parameters, or a fragment.");
  }
  const isLoopback = new Set(["localhost", "127.0.0.1", "[::1]"]).has(url.hostname);
  if (!isLoopback && url.protocol !== "https:") {
    throw new Error("Non-local relays must use HTTPS.");
  }
  if (!isLoopback && !process.env.CODEX_LINK_ACCESS_TOKEN?.trim()) {
    throw new Error("Set CODEX_LINK_ACCESS_TOKEN before using a non-local relay.");
  }
  if (url.hostname.toLowerCase().endsWith(".chatgpt.site")) {
    if (!process.env.CODEX_LINK_SITES_BYPASS_TOKEN?.trim()) {
      throw new Error("Set CODEX_LINK_SITES_BYPASS_TOKEN before using a private ChatGPT Site relay.");
    }
    if (url.origin !== configuredSitesOrigin()) {
      throw new Error("The private Site relay URL must match CODEX_LINK_SITES_ALLOWED_ORIGIN exactly.");
    }
  }
  return url.toString().replace(/\/$/, "");
}

export function createRoom(baseUrl, roomId, participantId) {
  return request(baseUrl, "/v1/rooms", { method: "POST", body: { roomId, participantId } });
}

export function joinRoom(baseUrl, roomId, participantId) {
  return request(baseUrl, `/v1/rooms/${encodeURIComponent(roomId)}/join`, {
    method: "POST",
    body: { participantId },
  });
}

export function getRoomStatus(baseUrl, roomId, participantId) {
  return request(baseUrl, `/v1/rooms/${encodeURIComponent(roomId)}/status`, {
    query: { participantId },
  });
}

export function sendEnvelope(baseUrl, envelope) {
  return request(baseUrl, `/v1/rooms/${encodeURIComponent(envelope.roomId)}/messages`, {
    method: "POST",
    body: envelope,
  });
}

export function receiveEnvelopes(baseUrl, roomId, participantId, waitMs = 0) {
  return request(baseUrl, `/v1/rooms/${encodeURIComponent(roomId)}/messages`, {
    query: { participantId, waitMs },
  });
}

export function acknowledgeEnvelopes(baseUrl, roomId, participantId, messageIds) {
  return request(baseUrl, `/v1/rooms/${encodeURIComponent(roomId)}/acks`, {
    method: "POST",
    body: { participantId, messageIds },
  });
}

export function closeRoom(baseUrl, roomId, participantId) {
  return request(baseUrl, `/v1/rooms/${encodeURIComponent(roomId)}`, {
    method: "DELETE",
    body: { participantId },
  });
}
