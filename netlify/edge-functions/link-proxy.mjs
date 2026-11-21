import { ATTESTATION_HEADER, readBoundedBody, signEdgeRequest } from "../lib/edge-attestation.mjs";
import { PUBLIC_ORIGIN, SITE_ID } from "../lib/config.mjs";

const error = (status, code) => Response.json({ error: { code, message: "Operation is unconfirmed. Keep the same private credential and requestId." } }, { status, headers: { "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" } });

// The edge only authenticates the hosting hop and forwards bytes; room auth,
// history, storage encryption, receipts and expiry execute on Neon Functions.
export async function proxyLink(request, context, { environment, fetcher = fetch } = {}) {
  const incoming = new URL(request.url);
  if (incoming.origin !== PUBLIC_ORIGIN || context.site?.id !== SITE_ID) return error(421, "CANONICAL_ORIGIN_REQUIRED");
  let upstream;
  try { upstream = new URL(environment.get("LINK_NEON_API_ORIGIN")); } catch {}
  const secret = environment.get("LINK_PROXY_KEY");
  if (!upstream || upstream.protocol !== "https:" || !/^[a-z0-9-]+\.compute\.[a-z0-9.-]+\.aws\.neon\.tech$/.test(upstream.hostname) ||
      upstream.port || upstream.username || upstream.password || upstream.pathname !== "/" || upstream.search || upstream.hash ||
      !/^[A-Za-z0-9_-]{43}$/.test(secret ?? "")) return error(503, "PROXY_NOT_CONFIGURED");
  upstream.pathname = incoming.pathname; upstream.search = incoming.search;
  let body;
  try { body = await readBoundedBody(request); } catch (e) { return error(e instanceof RangeError ? 413 : 400, "BODY_LIMIT"); }
  try {
    const proof = await signEdgeRequest(request, body, { secret, ip: context.ip, siteId: SITE_ID, origin: PUBLIC_ORIGIN });
    // Explicitly copy only consumer headers needed by the existing protocol.
    const headers = new Headers();
    for (const h of ["authorization", "cookie", "origin", "sec-fetch-site", "content-type"]) {
      const value = request.headers.get(h); if (value !== null) headers.set(h, value);
    }
    headers.set(ATTESTATION_HEADER, proof);
    const response = await fetcher(upstream, { method: request.method, headers,
      ...(request.method === "GET" || request.method === "HEAD" ? {} : { body }),
      redirect: "manual", signal: AbortSignal.timeout(24000),
    });
    // The fixed upstream is not allowed to redirect credentials elsewhere.
    if (response.status >= 300 && response.status < 400) return error(502, "UPSTREAM_REDIRECT_REJECTED");
    const returned = new Headers(response.headers);
    for (const header of ["location", "access-control-allow-origin", "access-control-allow-credentials", "server"]) returned.delete(header);
    returned.set("cache-control", "no-store"); returned.set("referrer-policy", "no-referrer");
    returned.set("x-link-execution", "neon-functions");
    return new Response(response.body, { status: response.status, headers: returned });
  } catch { return error(503, "LINK_UNAVAILABLE"); }
}
export default (request, context) => proxyLink(request, context, { environment: Netlify.env });
export const config = { path: "/link/v1/*", cache: "manual", onError: "fail",
  rateLimit: { action: "rate_limit", aggregateBy: ["domain", "ip"], windowSize: 60, windowLimit: 240 },
};
