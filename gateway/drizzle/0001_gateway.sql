CREATE TABLE link_gateway_sessions (
  session_id TEXT PRIMARY KEY NOT NULL,
  token_hash TEXT UNIQUE NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  state_ciphertext TEXT,
  provision_hash TEXT UNIQUE,
  provision_fingerprint TEXT,
  provision_ciphertext TEXT,
  provision_until INTEGER NOT NULL DEFAULT 0,
  lease_nonce TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE INDEX link_gateway_sessions_expiry ON link_gateway_sessions (expires_at);
--> statement-breakpoint
CREATE TABLE link_gateway_limits (
  bucket_key TEXT PRIMARY KEY NOT NULL,
  window_started_at INTEGER NOT NULL,
  request_count INTEGER NOT NULL
);
