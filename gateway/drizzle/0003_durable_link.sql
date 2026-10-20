CREATE TABLE link_rooms_v2 (
  room_id TEXT PRIMARY KEY NOT NULL,
  audience TEXT NOT NULL,
  invite_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  closed_at INTEGER
);
--> statement-breakpoint
CREATE INDEX link_rooms_v2_expiry ON link_rooms_v2 (expires_at);
--> statement-breakpoint
CREATE TABLE link_participants_v2 (
  participant_id TEXT PRIMARY KEY NOT NULL,
  room_id TEXT NOT NULL REFERENCES link_rooms_v2(room_id) ON DELETE CASCADE,
  credential_hash TEXT UNIQUE NOT NULL,
  setup_fingerprint TEXT NOT NULL,
  name_ciphertext TEXT NOT NULL,
  role TEXT NOT NULL,
  consented_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  offered_cursor INTEGER NOT NULL DEFAULT 0,
  confirmed_cursor INTEGER NOT NULL DEFAULT 0,
  read_cursor INTEGER NOT NULL DEFAULT 0,
  revoked_at INTEGER
);
--> statement-breakpoint
CREATE INDEX link_participants_v2_room ON link_participants_v2 (room_id);
--> statement-breakpoint
CREATE TABLE link_messages_v2 (
  sequence INTEGER NOT NULL,
  room_id TEXT NOT NULL REFERENCES link_rooms_v2(room_id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL REFERENCES link_participants_v2(participant_id) ON DELETE CASCADE,
  message_id TEXT UNIQUE NOT NULL,
  request_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  payload_ciphertext TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (sender_id, request_id),
  PRIMARY KEY (room_id, sequence)
);
--> statement-breakpoint
CREATE INDEX link_messages_v2_cursor ON link_messages_v2 (room_id, sequence);
--> statement-breakpoint
CREATE TABLE link_deliveries_v2 (
  message_id TEXT NOT NULL REFERENCES link_messages_v2(message_id) ON DELETE CASCADE,
  participant_id TEXT NOT NULL REFERENCES link_participants_v2(participant_id) ON DELETE CASCADE,
  confirmed_at INTEGER,
  read_at INTEGER,
  PRIMARY KEY (message_id, participant_id)
);
--> statement-breakpoint
CREATE TABLE link_waiters_v2 (
  waiter_id TEXT PRIMARY KEY NOT NULL,
  participant_id TEXT NOT NULL REFERENCES link_participants_v2(participant_id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX link_waiters_v2_participant ON link_waiters_v2 (participant_id, expires_at);
