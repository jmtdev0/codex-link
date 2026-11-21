import { getLinkPool } from "../lib/database.mjs";
import { createNeonService } from "../lib/service.mjs";

export default { fetch: createNeonService({ getPool: getLinkPool,
  masterKey: () => process.env.LINK_GATEWAY_MASTER_KEY, proxyKey: () => process.env.LINK_PROXY_KEY,
  onError: diagnostic => console.error("Link storage diagnostic", diagnostic),
}) };
