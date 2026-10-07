-- Group Chat Referee schema. Safe to run more than once.
-- D1 enforces foreign keys, so deleting a room removes its members and decisions.

CREATE TABLE IF NOT EXISTS rooms (
  code TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS members (
  room TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
  name TEXT NOT NULL COLLATE NOCASE,
  area TEXT NOT NULL,
  cuisines TEXT NOT NULL DEFAULT '[]',
  dietary TEXT NOT NULL DEFAULT '[]',
  notes TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (room, name)
);

-- One row per referee run. picks is a JSON array of up to three places with
-- their reasons and per-person travel times; it is empty when the referee
-- could not pick, and summary then holds the explanation.
-- (An older prototype had a `decisions` table. It is no longer used and can
-- be dropped by hand with DROP TABLE decisions.)
CREATE TABLE IF NOT EXISTS shortlists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  room TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  picks TEXT NOT NULL DEFAULT '[]',
  unlocated TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS shortlists_room ON shortlists (room, id);
