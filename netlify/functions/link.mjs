import { getDatabase } from "@netlify/database";
import { createNetlifyService } from "../lib/service.mjs";

export default createNetlifyService({
  getPool: () => getDatabase().pool,
  masterKey: () => process.env.LINK_GATEWAY_MASTER_KEY,
  onError: diagnostic => console.error("Link storage diagnostic", diagnostic),
});

export const config = {
  path: "/link/v1/*",
  rateLimit: { action: "rate_limit", aggregateBy: ["domain", "ip"], windowSize: 60, windowLimit: 240 },
};
