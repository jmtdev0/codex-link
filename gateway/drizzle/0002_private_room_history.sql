CREATE TABLE link_gateway_histories (
  history_id TEXT PRIMARY KEY NOT NULL,
  audience TEXT NOT NULL,
  room_hash TEXT UNIQUE,
  view_hash TEXT NOT NULL,
  manage_hash TEXT NOT NULL,
  metadata_ciphertext TEXT NOT NULL,
  recording_incomplete INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  import_hash TEXT UNIQUE,
  import_fingerprint TEXT,
  import_until INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE INDEX link_gateway_histories_expiry ON link_gateway_histories (expires_at);
--> statement-breakpoint
CREATE TABLE link_gateway_history_messages (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  history_id TEXT NOT NULL REFERENCES link_gateway_histories(history_id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  payload_ciphertext TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  UNIQUE (history_id, message_id)
);
--> statement-breakpoint
CREATE INDEX link_gateway_history_messages_room_sequence ON link_gateway_history_messages (history_id, sequence);
