/**
 * D1 access for rooms, members and shortlists.
 *
 * Every function takes the D1 binding as its first argument. The SQL is kept
 * to a handful of simple statements so the in-memory fake used in tests can
 * mirror them exactly.
 */

export const ROOM_TTL_MS = 24 * 60 * 60 * 1000;
export const MAX_MEMBERS = 10;
const HISTORY_LIMIT = 10;
const CODE_ATTEMPTS = 5;

// 32 characters, no 0/O or 1/I look-alikes. 256 is a multiple of 32, so
// `byte % 32` is unbiased.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const CODE_PATTERN = /^[A-HJ-NP-Z2-9]{5}$/;

export function generateCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(5));
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

/**
 * Create a room and return its code. Rooms older than the TTL are deleted
 * first, which cascades to their members and shortlists.
 */
export async function createRoom(db, now = Date.now()) {
  await db.prepare("DELETE FROM rooms WHERE created_at < ?").bind(now - ROOM_TTL_MS).run();

  for (let attempt = 0; attempt < CODE_ATTEMPTS; attempt++) {
    const code = generateCode();
    try {
      await db.prepare("INSERT INTO rooms (code, created_at) VALUES (?, ?)").bind(code, now).run();
      return code;
    } catch {
      // Primary key collision: try another code.
    }
  }
  throw new Error("Could not allocate a room code");
}

export async function roomExists(db, code) {
  const row = await db.prepare("SELECT code FROM rooms WHERE code = ?").bind(code).first();
  return row !== null;
}

export async function listMembers(db, room) {
  const { results } = await db
    .prepare(
      "SELECT name, area, cuisines, dietary, notes, updated_at FROM members WHERE room = ? ORDER BY updated_at, name",
    )
    .bind(room)
    .all();
  return results.map((row) => ({
    name: row.name,
    area: row.area,
    cuisines: JSON.parse(row.cuisines),
    dietary: JSON.parse(row.dietary),
    notes: row.notes,
    updated_at: row.updated_at,
  }));
}

/**
 * Add a member, or edit the existing one with the same name (case-insensitive).
 * The size check is not atomic, so two simultaneous joins could overshoot the
 * cap by one. That is accepted for a friends-only tool.
 */
export async function upsertMember(db, room, member, now = Date.now()) {
  const existing = await db
    .prepare("SELECT 1 AS found FROM members WHERE room = ? AND name = ?")
    .bind(room, member.name)
    .first();

  if (!existing) {
    const { n } = await db.prepare("SELECT COUNT(*) AS n FROM members WHERE room = ?").bind(room).first();
    if (n >= MAX_MEMBERS) {
      return { error: `Room is full (max ${MAX_MEMBERS} members)` };
    }
  }

  await db
    .prepare(
      `INSERT INTO members (room, name, area, cuisines, dietary, notes, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(room, name) DO UPDATE SET
         area = excluded.area,
         cuisines = excluded.cuisines,
         dietary = excluded.dietary,
         notes = excluded.notes,
         updated_at = excluded.updated_at`,
    )
    .bind(
      room,
      member.name,
      member.area,
      JSON.stringify(member.cuisines),
      JSON.stringify(member.dietary),
      member.notes,
      now,
    )
    .run();
  return { ok: true };
}

/**
 * Save one referee run. picks is empty when the referee could not pick, and
 * summary then explains why.
 */
export async function addShortlist(db, room, { summary, picks = [], unlocated = [] }, now = Date.now()) {
  await db
    .prepare(
      "INSERT INTO shortlists (room, summary, picks, unlocated, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .bind(room, summary, JSON.stringify(picks), JSON.stringify(unlocated), now)
    .run();
}

/**
 * Most recent shortlists first.
 */
export async function listShortlists(db, room) {
  const { results } = await db
    .prepare(
      `SELECT id, summary, picks, unlocated, created_at FROM shortlists WHERE room = ? ORDER BY id DESC LIMIT ${HISTORY_LIMIT}`,
    )
    .bind(room)
    .all();
  return results.map((row) => ({
    id: row.id,
    summary: row.summary,
    picks: JSON.parse(row.picks),
    unlocated: JSON.parse(row.unlocated),
    created_at: row.created_at,
  }));
}
