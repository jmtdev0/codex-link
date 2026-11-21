import { parseTriggerDelivery } from "@neon/functions/triggers";
import { getLinkPool } from "../lib/database.mjs";
import { createPostgresStore } from "../../netlify/lib/postgres.mjs";

export default {
  async fetch(request) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/") return new Response(null, { status: 404 });
    const delivery = await parseTriggerDelivery(request);
    if (!delivery.ok || delivery.invocation.type !== "schedule" || delivery.invocation.trigger.name !== "link-daily-cleanup") return new Response(null, { status: 401 });
    try {
      const DB = createPostgresStore(getLinkPool()), now = Date.now();
      await DB.batch([
        DB.prepare("DELETE FROM link_rooms_v2 WHERE room_id IN (SELECT room_id FROM link_rooms_v2 WHERE expires_at <= ? ORDER BY expires_at LIMIT 5)").bind(now),
        DB.prepare("DELETE FROM link_waiters_v2 WHERE expires_at <= ?").bind(now),
        DB.prepare("DELETE FROM link_gateway_limits WHERE window_started_at <= ?").bind(now - 86400000),
      ]);
      return Response.json({ swept: true }, { headers: { "cache-control": "no-store" } });
    } catch { return Response.json({ swept: false }, { status: 503, headers: { "cache-control": "no-store" } }); }
  },
};
