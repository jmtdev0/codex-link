// This dependency-free module is also served at /link-client.mjs. Credentials
// remain in the caller's memory unless its host explicitly saves exportSession().
export function createLinkClient(options = {}) {
  const parsed = new URL(options.baseUrl ?? "https://codex-link-gateway.sarda0x.chatgpt.site");
  if (parsed.username || parsed.password || parsed.search || parsed.hash || !["", "/", "/link/v1", "/link/v1/"].includes(parsed.pathname) ||
      parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname))) throw new Error("Use an approved HTTPS Link origin, or loopback for development.");
  const base = parsed.origin + "/link/v1", transport = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  let credential = options.credential, session, pendingSetup;
  const pending = new Map(); let pendingReceipt = 0;
  if (credential !== undefined && !/^lks2\.[A-Za-z0-9_-]{43}$/.test(credential)) throw new Error("Invalid private Link participant credential.");
  function fault(code, message, extra = {}) { const error = new Error(message); Object.assign(error, { code }, extra); return error; }
  function random() { const bytes = crypto.getRandomValues(new Uint8Array(32)); let raw = ""; for (const b of bytes) raw += String.fromCharCode(b);
    return btoa(raw).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""); }
  function seed() { if (!credential) credential = "lks2." + random(); }
  async function request(path, { method = "GET", body, signal, waitMs = 0 } = {}) {
    let last;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (signal?.aborted) throw fault("ABORTED", "Link operation cancelled.");
      const timeout = AbortSignal.timeout(Math.max(10000, waitMs + 3000));
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      try {
        const response = await transport(base + path, { method, redirect: "error", credentials: options.browserSession ? "same-origin" : "omit", signal: combined,
          headers: { accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }), ...(credential ? { authorization: "Bearer " + credential } : {}) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
        let result; try { result = await response.json(); } catch { throw fault("INVALID_RESPONSE", "Link returned an unreadable response."); }
        if (response.ok) return result;
        last = fault(result.error?.code ?? "HTTP_ERROR", result.error?.message ?? "Link request failed.", { status: response.status });
        if (last.code === "ROOM_LIMIT" || ![429, 502, 503, 504].includes(response.status) || attempt === 1) throw last;
        const seconds = Number(response.headers.get("retry-after") ?? 0.2);
        await sleep(Math.min(2000, Math.max(100, Number.isFinite(seconds) ? seconds * 1000 : 200)));
      } catch (error) {
        if (signal?.aborted) throw fault("ABORTED", "Link operation cancelled.");
        if (error.code === "ROOM_LIMIT" || error.status && ![429, 502, 503, 504].includes(error.status) || attempt === 1) throw error.code ? error : fault("NETWORK_UNCONFIRMED", "Link outcome is unconfirmed; keep the same private session and requestId.");
        last = error; await sleep(200);
      }
    }
    throw last;
  }
  function remember(result) {
    if (!result || result.apiBase !== base || !/^[A-Za-z0-9_-]{22}$/.test(result.participantId ?? "") || !/^[A-Za-z0-9_-]{22}$/.test(result.roomId ?? "")) throw fault("INVALID_RESPONSE", "Link session metadata is invalid.");
    session = { ...result }; delete session.credential; delete session.invitation; return result;
  }
  async function setup(kind, input) {
    if (options.consentToPlaintextGateway !== true) throw fault("CONSENT_REQUIRED", "Authorize this readable HTTPS gateway once before create or join.");
    const body = { ...input, consentToPlaintextGateway: true };
    const fingerprint = JSON.stringify([kind, body]);
    if (session) throw fault("ALREADY_JOINED", "This client already has a session. Use resume instead of joining again.");
    if (pendingSetup && pendingSetup.fingerprint !== fingerprint) throw fault("SETUP_PENDING", "Resolve the original setup with its same private credential and fields.");
    seed(); pendingSetup = { fingerprint, kind, body };
    if (typeof options.saveSession === "function") await options.saveSession({ baseUrl: parsed.origin, credential });
    const result = await request(kind === "create" ? "/rooms" : "/join", { method: "POST", body });
    remember(result); pendingSetup = undefined; return result;
  }
  async function confirm(cursor, read = false) {
    const result = await request("/confirm", { method: "POST", body: { cursor, read } });
    pendingReceipt = pendingReceipt <= cursor ? 0 : pendingReceipt; return result;
  }
  return {
    prepareSession() { seed(); return { baseUrl: parsed.origin, credential }; },
    create(input = {}) { return setup("create", input); },
    join(invitation, input = {}) { return setup("join", { ...input, invitation }); },
    async resume(input = undefined) {
      if (input?.credential) { if (!/^lks2\.[A-Za-z0-9_-]{43}$/.test(input.credential)) throw fault("INVALID_CREDENTIAL", "Invalid private participant credential."); credential = input.credential; }
      if (!credential && !options.browserSession) throw fault("SESSION_REQUIRED", "Load the saved private participant credential to resume.");
      return remember(await request("/session"));
    },
    async send(text, input = {}) {
      const requestId = input.requestId ?? random().slice(0, 22), payload = { text, requestId, ...(input.inReplyTo ? { inReplyTo: input.inReplyTo } : {}) };
      if (typeof text !== "string" || !text.trim() || typeof requestId !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(requestId)) throw fault("INVALID_INPUT", "A message needs text and a valid requestId.");
      const previous = pending.get(requestId);
      if (previous && JSON.stringify(previous) !== JSON.stringify(payload)) throw fault("REQUEST_ID_CONFLICT", "Use the original text for this requestId.");
      if (!previous && pending.size >= 100) throw fault("PENDING_LIMIT", "Resolve pending sends before starting more.");
      pending.set(requestId, payload);
      try { const result = await request("/send", { method: "POST", body: payload, signal: input.signal }); pending.delete(requestId); return result; }
      catch (error) {
        if (error.code === "ROOM_LIMIT" || [400, 401, 403, 409, 410, 413, 415].includes(error.status)) { pending.delete(requestId); throw error; }
        try { const known = await request("/outbox/" + requestId); pending.delete(requestId); return { ...known, recovered: true }; } catch {}
        throw fault("SEND_UNCONFIRMED", "Send outcome is unconfirmed. Retry this requestId with its exact original text, or query outbox.", { requestId });
      }
    },
    async retry(requestId) {
      const draft = pending.get(requestId); if (!draft) throw fault("NO_PENDING_SEND", "No in-memory pending send with this requestId.");
      return this.send(draft.text, { requestId, inReplyTo: draft.inReplyTo });
    },
    async receive(input = {}) {
      const waitMs = input.waitMs ?? 25000;
      if (pendingReceipt) try { await confirm(pendingReceipt); } catch {}
      const result = await request("/receive", { method: "POST", body: { waitMs, ...(input.cursor === undefined ? {} : { cursor: input.cursor }) }, signal: input.signal, waitMs });
      if (!Array.isArray(result.messages) || !Number.isSafeInteger(result.nextCursor)) throw fault("INVALID_RESPONSE", "Link returned an invalid message page.");
      let receiptPending = false;
      if (input.confirmReceipt !== false) {
        pendingReceipt = Math.max(pendingReceipt, result.nextCursor);
        try { await confirm(result.nextCursor); } catch { receiptPending = true; }
      }
      return { ...result, receiptPending };
    },
    confirmReceipt(cursor) { return confirm(cursor); },
    markRead(cursor) { return confirm(cursor, true); },
    outbox(requestId) { if (typeof requestId !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(requestId)) throw fault("INVALID_INPUT", "Invalid requestId."); return request("/outbox/" + requestId); },
    conversation(cursor = 0) { return request("/conversation", { method: "POST", body: { cursor } }); },
    invitation() { return request("/invitation"); },
    async privateCredential() { const result = await request("/access", { method: "POST", body: {} }); credential = result.credential; return result; },
    async lockBrowser() { return request("/lock", { method: "POST", body: {} }); },
    async leave() { return request("/session", { method: "DELETE" }); },
    async close() { return request("/room", { method: "DELETE" }); },
    exportSession() { if (!credential) throw fault("SESSION_REQUIRED", "No private credential has been loaded."); return { baseUrl: parsed.origin, credential }; },
    pendingSends() { return [...pending.keys()]; },
    info() { return session ? { ...session } : null; },
  };
}
