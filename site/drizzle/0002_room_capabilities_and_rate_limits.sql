ALTER TABLE codex_link_rooms
  ADD COLUMN capability_hash TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
CREATE TABLE codex_link_rate_limits (
  bucket_key TEXT PRIMARY KEY,
  window_started_at INTEGER NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count >= 0)
);
--> statement-breakpoint
CREATE INDEX idx_codex_link_rate_limits_window
  ON codex_link_rate_limits (window_started_at);
