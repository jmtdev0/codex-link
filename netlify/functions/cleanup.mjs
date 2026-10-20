import { getDatabase } from "@netlify/database";
import { createPostgresStore } from "../lib/postgres.mjs";
import { ensureSchema } from "../lib/schema.mjs";

export default async () => {
  const pool = getDatabase().pool;
  await ensureSchema(pool);
  const DB = createPostgresStore(pool);
  const now = Date.now();
  // Bound each sweep. Expiry is enforced synchronously by the API regardless
  // of this physical cleanup, and neither this job nor traffic extends expiry.
  await DB.batch([
    DB.prepare("DELETE FROM link_rooms_v2 WHERE room_id IN (SELECT room_id FROM link_rooms_v2 WHERE expires_at <= ? ORDER BY expires_at LIMIT 5)").bind(now),
    DB.prepare("DELETE FROM link_waiters_v2 WHERE expires_at <= ?").bind(now),
    DB.prepare("DELETE FROM link_gateway_limits WHERE window_started_at <= ?").bind(now - 86400000),
  ]);
};

// A daily sweep avoids keeping a small/idle database permanently awake.
export const config = { schedule: "@daily" };
