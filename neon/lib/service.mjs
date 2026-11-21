import { createNetlifyService, PUBLIC_ORIGIN, SITE_ID } from "../../netlify/lib/service.mjs";
import { ATTESTATION_HEADER, readBoundedBody, verifyEdgeHeader, verifyEdgeBody } from "./attestation.mjs";

const fail = status => Response.json({ error: { code: status === 413 ? "BODY_LIMIT" : "PROXY_REQUIRED", message: "Use the published Link origin." } }, { status, headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" } });

export function createNeonService({ getPool, masterKey, proxyKey, now = Date.now, onError = () => {} } = {}) {
  const service = createNetlifyService({ getPool, masterKey, now, onError, initializeSchema: false,
    serviceOptions: { clientPolling: true, pollAfterMs: 10000, cleanupOnRequest: false },
    deploymentInfo: { version: "0.13.3", hosting: "netlify", edgeProxy: "netlify-cdn", execution: "neon-functions", deployment: "0.13.3-neon.1" },
  });
  return async request => {
    // Reject direct callers before body parsing, database work, or consumer auth.
    if (!request.headers.has(ATTESTATION_HEADER)) return fail(401);
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/link/v1/")) return fail(404);
    const proof = await verifyEdgeHeader(request, { secret: proxyKey(), siteId: SITE_ID, origin: PUBLIC_ORIGIN, now: now() });
    if (!proof) return fail(401);
    let body;
    try { body = await readBoundedBody(request); } catch (error) { return fail(error instanceof RangeError ? 413 : 400); }
    if (!await verifyEdgeBody(proof, body)) return fail(401);
    const canonical = new URL(PUBLIC_ORIGIN); canonical.pathname = url.pathname; canonical.search = url.search;
    const headers = new Headers(request.headers);
    for (const header of [ATTESTATION_HEADER, "host", "content-length", "connection", "transfer-encoding"]) headers.delete(header);
    return service(new Request(canonical, { method: request.method, headers,
      ...(request.method === "GET" || request.method === "HEAD" ? {} : { body }),
    }), { site: { id: SITE_ID }, ip: proof.ip });
  };
}
