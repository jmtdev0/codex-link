CREATE TABLE IF NOT EXISTS link_gateway_limits (
  bucket_key TEXT PRIMARY KEY,
  window_started_at BIGINT NOT NULL,
  request_count INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS link_rooms_v2 (
  room_id TEXT PRIMARY KEY,
  audience TEXT NOT NULL,
  invite_hash TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  closed_at BIGINT
);
CREATE INDEX IF NOT EXISTS link_rooms_v2_expiry ON link_rooms_v2 (expires_at);
CREATE TABLE IF NOT EXISTS link_participants_v2 (
  participant_id TEXT PRIMARY KEY,
  room_id TEXT NOT NULL REFERENCES link_rooms_v2(room_id) ON DELETE CASCADE,
  credential_hash TEXT UNIQUE NOT NULL,
  setup_fingerprint TEXT NOT NULL,
  name_ciphertext TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  consented_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  offered_cursor BIGINT NOT NULL DEFAULT 0,
  confirmed_cursor BIGINT NOT NULL DEFAULT 0,
  read_cursor BIGINT NOT NULL DEFAULT 0,
  revoked_at BIGINT
);
CREATE INDEX IF NOT EXISTS link_participants_v2_room ON link_participants_v2 (room_id);
CREATE TABLE IF NOT EXISTS link_messages_v2 (
  sequence BIGINT NOT NULL,
  room_id TEXT NOT NULL REFERENCES link_rooms_v2(room_id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL REFERENCES link_participants_v2(participant_id) ON DELETE CASCADE,
  message_id TEXT UNIQUE NOT NULL,
  request_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  payload_ciphertext TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at BIGINT NOT NULL,
  UNIQUE (sender_id, request_id),
  PRIMARY KEY (room_id, sequence)
);
CREATE INDEX IF NOT EXISTS link_messages_v2_cursor ON link_messages_v2 (room_id, sequence);
CREATE TABLE IF NOT EXISTS link_deliveries_v2 (
  message_id TEXT NOT NULL REFERENCES link_messages_v2(message_id) ON DELETE CASCADE,
  participant_id TEXT NOT NULL REFERENCES link_participants_v2(participant_id) ON DELETE CASCADE,
  confirmed_at BIGINT,
  read_at BIGINT,
  PRIMARY KEY (message_id, participant_id)
);
CREATE INDEX IF NOT EXISTS link_deliveries_v2_participant ON link_deliveries_v2 (participant_id);
CREATE TABLE IF NOT EXISTS link_waiters_v2 (
  waiter_id TEXT PRIMARY KEY,
  participant_id TEXT NOT NULL REFERENCES link_participants_v2(participant_id) ON DELETE CASCADE,
  expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS link_waiters_v2_participant ON link_waiters_v2 (participant_id, expires_at);
