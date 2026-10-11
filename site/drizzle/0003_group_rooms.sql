ALTER TABLE codex_link_rooms
  ADD COLUMN protocol_version INTEGER NOT NULL DEFAULT 1 CHECK (protocol_version IN (1, 2));
--> statement-breakpoint
CREATE TABLE codex_link_room_members (
  room_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  public_key TEXT,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, participant_id),
  FOREIGN KEY (room_id) REFERENCES codex_link_rooms (room_id) ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO codex_link_room_members (room_id, participant_id, role, public_key, joined_at)
SELECT room_id, owner_id, 'owner', NULL, 0 FROM codex_link_rooms;
--> statement-breakpoint
INSERT OR IGNORE INTO codex_link_room_members (room_id, participant_id, role, public_key, joined_at)
SELECT room_id, peer_id, 'member', NULL, 0 FROM codex_link_rooms WHERE peer_id IS NOT NULL;
--> statement-breakpoint
CREATE INDEX idx_codex_link_room_members_room
  ON codex_link_room_members (room_id, joined_at, participant_id);
