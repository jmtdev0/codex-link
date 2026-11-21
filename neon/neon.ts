import { defineConfig } from "@neon/config/v1";

// The operator injects both secrets into the deployment process, never source.
// No local env pull, new Auth provider, or database schema change is required.
export default defineConfig({
  functions: {
    linkapi: {
      name: "Link HTTPS API",
      source: "./functions/api.mjs",
      env: {
        LINK_GATEWAY_MASTER_KEY: process.env.LINK_GATEWAY_MASTER_KEY!,
        LINK_PROXY_KEY: process.env.LINK_PROXY_KEY!,
      },
    },
    linkcleanup: { name: "Link daily expiry sweep", source: "./functions/cleanup.mjs" },
  },
  triggers: {
    "link-daily-cleanup": { type: "schedule", function: "linkcleanup", cron: "17 3 * * *", enabled: true },
  },
});
