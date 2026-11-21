// Shared Web Crypto protocol, kept inside the Netlify edge bundler's base path.
// Binds the trusted edge IP and the complete request.
// There are no secrets, room contents, or credentials in source/configuration.
export const ATTESTATION_HEADER = "x-link-edge-proof";
const encoder = new TextEncoder();
const b64 = bytes => btoa(Array.from(bytes, b => String.fromCharCode(b)).join("")).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
function unb64(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid encoding");
  const bytes = Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0));
  if (b64(bytes) !== value) throw new Error("Noncanonical encoding");
  return bytes;
}
const digest = async value => b64(new Uint8Array(await crypto.subtle.digest("SHA-256", value)));
async function key(secret, usages) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret ?? "")) throw new Error("Proxy key unavailable");
  return crypto.subtle.importKey("raw", unb64(secret), { name: "HMAC", hash: "SHA-256" }, false, usages);
}
const boundHeaders = request => JSON.stringify(["authorization", "cookie", "origin", "sec-fetch-site", "content-type"].map(h => request.headers.get(h) ?? ""));

export async function readBoundedBody(request, limit = 16384) {
  if (!request.body) return new Uint8Array();
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw new RangeError("Body limit");
  const reader = request.body.getReader();
  const chunks = []; let length = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      length += next.value.length;
      if (length > limit) { await reader.cancel(); throw new RangeError("Body limit"); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

export async function signEdgeRequest(request, body, { secret, ip, siteId, origin, now = Date.now() }) {
  if (typeof ip !== "string" || !/^[0-9a-fA-F:.]{3,128}$/.test(ip)) throw new Error("Trusted IP unavailable");
  const url = new URL(request.url);
  const payload = [1, now, b64(crypto.getRandomValues(new Uint8Array(16))), ip, siteId, origin,
    request.method, url.pathname + url.search, await digest(body), await digest(encoder.encode(boundHeaders(request)))];
  const encoded = b64(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign("HMAC", await key(secret, ["sign"]), encoder.encode("link-edge/v1." + encoded));
  return encoded + "." + b64(new Uint8Array(signature));
}

export async function verifyEdgeHeader(request, { secret, siteId, origin, now = Date.now() }) {
  try {
    const proof = request.headers.get(ATTESTATION_HEADER);
    if (!proof || proof.length > 2048 || proof.split(".").length !== 2) return null;
    const [encoded, signature] = proof.split(".");
    const valid = await crypto.subtle.verify("HMAC", await key(secret, ["verify"]), unb64(signature), encoder.encode("link-edge/v1." + encoded));
    if (!valid) return null;
    const value = JSON.parse(new TextDecoder().decode(unb64(encoded)));
    if (!Array.isArray(value) || value.length !== 10) return null;
    const [version, issued, nonce, ip, site, audience, method, path, bodyHash, headersHash] = value;
    const url = new URL(request.url);
    if (version !== 1 || !Number.isSafeInteger(issued) || issued > now + 5000 || now - issued > 60000 ||
        typeof nonce !== "string" || !/^[A-Za-z0-9_-]{22}$/.test(nonce) ||
        typeof ip !== "string" || !/^[0-9a-fA-F:.]{3,128}$/.test(ip) ||
        site !== siteId || audience !== origin || method !== request.method || path !== url.pathname + url.search ||
        typeof bodyHash !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(bodyHash) ||
        headersHash !== await digest(encoder.encode(boundHeaders(request)))) return null;
    return { ip, origin: audience, bodyHash };
  } catch { return null; }
}

export async function verifyEdgeBody(proof, body) { return proof?.bodyHash === await digest(body); }
export async function verifyEdgeRequest(request, body, options) {
  const proof = await verifyEdgeHeader(request, options);
  return proof && await verifyEdgeBody(proof, body) ? { ip: proof.ip, origin: proof.origin } : null;
}
