import { createDurableLink } from "../../gateway/worker/link-v2.js";
import { createPostgresStore } from "./postgres.mjs";
import { ensureSchema } from "./schema.mjs";
import { PUBLIC_ORIGIN, SITE_ID } from "./config.mjs";
export { PUBLIC_ORIGIN, SITE_ID } from "./config.mjs";

export function createNetlifyService({ getPool, masterKey, origin = PUBLIC_ORIGIN, now = Date.now, serviceOptions = {}, initializeSchema = true, onError = () => {} } = {}) {
  const service = createDurableLink({ now, pollMs: 1500, ...serviceOptions, sourceAddress: (_request, env) => env.TRUSTED_SOURCE_IP });
  let storage;
  function database() {
    if (!storage) storage = (async () => {
      const pool = await getPool();
      if (initializeSchema) await ensureSchema(pool);
      return createPostgresStore(pool);
    })().catch(error => { storage = undefined; throw error; });
    return storage;
  }
  return async (request, context = {}) => {
    const url = new URL(request.url);
    if (url.origin !== origin) return Response.json({ error: { code: "CANONICAL_ORIGIN_REQUIRED", message: "Use the published Link origin." } }, { status: 421 });
    if (context.site?.id && context.site.id !== SITE_ID) return Response.json({ error: { code: "SITE_MISMATCH", message: "Unexpected hosting project." } }, { status: 503 });
    if (request.method === "GET" && url.pathname === "/link/v1/info") {
      const response = await service.fetch(request);
      if (!response.ok) return response;
      const info = await response.json();
      return Response.json({ ...info, hosting: "netlify", storage: "postgres", deployment: "0.13.1-netlify.2", agentSessionHelper: { version: "0.13.1", python: "/agent-session.py", privateStorageOptIn: true, implicitRejoin: false } }, { headers: response.headers });
    }
    // Fail cheaply for signed-out visitors before opening/waking the database.
    // Header contents remain untrusted: normal credential/origin validation
    // still happens in the shared service before any room data is returned.
    if (url.pathname !== "/link/v1/identity" && !request.headers.has("authorization") && !request.headers.get("cookie")?.includes("__Host-link-session-v2=")) {
      return Response.json({ error: { code: "SESSION_REQUIRED", message: "Join once or resume your private participant credential." } }, { status: 401, headers: { "cache-control": "no-store" } });
    }
    if (typeof context.ip !== "string" || !context.ip || context.ip.length > 128) return Response.json({ error: { code: "RATE_PROTECTION_UNAVAILABLE", message: "Trusted client address is unavailable." } }, { status: 503 });
    const key = masterKey();
    if (typeof key !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(key)) return Response.json({ error: { code: "NOT_CONFIGURED", message: "Link storage key is unavailable." } }, { status: 503 });
    try {
      return await service.fetch(request, { DB: await database(), LINK_GATEWAY_MASTER_KEY: key, TRUSTED_SOURCE_IP: context.ip });
    } catch (error) {
      // Never log raw exceptions: database errors can include credentials,
      // connection strings, SQL parameters or conversation content.
      const category = error?.name === "MissingDatabaseConnectionError" ? "DATABASE_ENVIRONMENT_MISSING" : "STORAGE_OPERATION_FAILED";
      const code = typeof error?.code === "string" && /^[A-Z0-9]{5}$/.test(error.code) ? error.code : undefined;
      try { onError({ category, ...(code ? { code } : {}) }); } catch {}
      return Response.json({ error: { code: "LINK_UNAVAILABLE", message: "Operation is unconfirmed. Keep the same private credential and requestId." } }, { status: 503, headers: { "cache-control": "no-store" } });
    }
  };
}
