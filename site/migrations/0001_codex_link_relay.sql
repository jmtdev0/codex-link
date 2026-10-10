CREATE TABLE codex_link_rooms (
  room_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  peer_id TEXT,
  expires_at INTEGER NOT NULL
);

CREATE INDEX idx_codex_link_rooms_expires_at
  ON codex_link_rooms (expires_at);

CREATE TABLE codex_link_messages (
  room_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, recipient_id, message_id),
  FOREIGN KEY (room_id) REFERENCES codex_link_rooms (room_id) ON DELETE CASCADE
);

CREATE INDEX idx_codex_link_messages_queue
  ON codex_link_messages (room_id, recipient_id, expires_at, created_at);

CREATE INDEX idx_codex_link_messages_expires_at
  ON codex_link_messages (expires_at);
