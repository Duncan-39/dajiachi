// A tiny in-memory stand-in for a D1 binding. It understands only the
// statements that src/db.js issues, matched by pattern, and throws on
// anything else so a new query cannot slip past the tests unnoticed.
export function createFakeD1() {
  const rooms = new Map(); // code -> { code, created_at }
  let members = []; // { room, name, area, cuisines, dietary, notes, updated_at }
  let shortlists = []; // { id, room, summary, picks, unlocated, created_at }
  let nextId = 1;

  const sameName = (a, b) => a.toLowerCase() === b.toLowerCase();

  const handlers = [
    [/^DELETE FROM rooms WHERE created_at < \?$/, ([cutoff]) => {
      for (const [code, room] of rooms) {
        if (room.created_at < cutoff) rooms.delete(code);
      }
      // ON DELETE CASCADE
      members = members.filter((m) => rooms.has(m.room));
      shortlists = shortlists.filter((s) => rooms.has(s.room));
    }],
    [/^INSERT INTO rooms \(code, created_at\) VALUES \(\?, \?\)$/, ([code, created_at]) => {
      if (rooms.has(code)) throw new Error("UNIQUE constraint failed: rooms.code");
      rooms.set(code, { code, created_at });
    }],
    [/^SELECT code FROM rooms WHERE code = \?$/, ([code]) =>
      rooms.has(code) ? [{ code }] : []],
    [/^SELECT name, area, cuisines, dietary, notes, updated_at FROM members WHERE room = \? ORDER BY updated_at, name$/, ([room]) =>
      members
        .filter((m) => m.room === room)
        .sort((a, b) => a.updated_at - b.updated_at || a.name.localeCompare(b.name))
        .map(({ room: _room, ...rest }) => rest)],
    [/^SELECT 1 AS found FROM members WHERE room = \? AND name = \?$/, ([room, name]) =>
      members.some((m) => m.room === room && sameName(m.name, name)) ? [{ found: 1 }] : []],
    [/^SELECT COUNT\(\*\) AS n FROM members WHERE room = \?$/, ([room]) =>
      [{ n: members.filter((m) => m.room === room).length }]],
    [/^INSERT INTO members \(room, name, area, cuisines, dietary, notes, updated_at\) VALUES \(\?, \?, \?, \?, \?, \?, \?\) ON CONFLICT\(room, name\) DO UPDATE SET area = excluded\.area, cuisines = excluded\.cuisines, dietary = excluded\.dietary, notes = excluded\.notes, updated_at = excluded\.updated_at$/,
      ([room, name, area, cuisines, dietary, notes, updated_at]) => {
        if (!rooms.has(room)) throw new Error("FOREIGN KEY constraint failed");
        const existing = members.find((m) => m.room === room && sameName(m.name, name));
        if (existing) Object.assign(existing, { area, cuisines, dietary, notes, updated_at });
        else members.push({ room, name, area, cuisines, dietary, notes, updated_at });
      }],
    [/^INSERT INTO shortlists \(room, summary, picks, unlocated, created_at\) VALUES \(\?, \?, \?, \?, \?\)$/, ([room, summary, picks, unlocated, created_at]) => {
      if (!rooms.has(room)) throw new Error("FOREIGN KEY constraint failed");
      shortlists.push({ id: nextId++, room, summary, picks, unlocated, created_at });
    }],
    [/^SELECT id, summary, picks, unlocated, created_at FROM shortlists WHERE room = \? ORDER BY id DESC LIMIT \d+$/, ([room]) =>
      shortlists
        .filter((s) => s.room === room)
        .sort((a, b) => b.id - a.id)
        .map(({ room: _room, ...rest }) => rest)],
  ];

  return {
    // Test helpers: peek at the stored rows.
    tables: {
      rooms,
      get members() { return members; },
      get shortlists() { return shortlists; },
    },
    prepare(sql) {
      const normalised = sql.replace(/\s+/g, " ").trim();
      const found = handlers.find(([pattern]) => pattern.test(normalised));
      if (!found) throw new Error(`fake D1: unsupported SQL: ${normalised}`);
      const run = found[1];
      const statement = (args) => ({
        bind: (...bound) => statement(bound),
        async run() {
          run(args);
          return { success: true };
        },
        async first() {
          return (run(args) ?? [])[0] ?? null;
        },
        async all() {
          return { results: run(args) ?? [] };
        },
      });
      return statement([]);
    },
  };
}
