import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CODE_PATTERN,
  MAX_MEMBERS,
  ROOM_TTL_MS,
  generateCode,
  createRoom,
  roomExists,
  listMembers,
  upsertMember,
  addShortlist,
  listShortlists,
} from "../src/db.js";
import { createFakeD1 } from "../test-support/fake-d1.mjs";

const member = (name, extra = {}) => ({
  name,
  area: "Bishan",
  cuisines: [],
  dietary: [],
  notes: "",
  ...extra,
});

test("generateCode makes 5 characters without look-alikes", () => {
  for (let i = 0; i < 200; i++) {
    const code = generateCode();
    assert.match(code, CODE_PATTERN);
    assert.doesNotMatch(code, /[01OI]/);
  }
});

test("createRoom stores a room that roomExists can find", async () => {
  const db = createFakeD1();
  const code = await createRoom(db);
  assert.equal(await roomExists(db, code), true);
  assert.equal(await roomExists(db, "ZZZZZ"), false);
});

test("createRoom deletes rooms past the TTL, with their members and shortlists", async () => {
  const db = createFakeD1();
  const now = 10 * ROOM_TTL_MS;
  const oldCode = await createRoom(db, now - ROOM_TTL_MS - 1);
  await upsertMember(db, oldCode, member("Mei"));
  await addShortlist(db, oldCode, { summary: "because", picks: [{ name: "Place" }] });
  const freshCode = await createRoom(db, now - 1000);

  await createRoom(db, now);

  assert.equal(await roomExists(db, oldCode), false);
  assert.equal(await roomExists(db, freshCode), true);
  assert.equal(db.tables.members.length, 0);
  assert.equal(db.tables.shortlists.length, 0);
});

test("upsertMember adds a member and parses JSON columns back", async () => {
  const db = createFakeD1();
  const code = await createRoom(db);
  await upsertMember(db, code, member("Mei", { cuisines: ["korean"], dietary: ["vegan"], notes: "hi" }));

  const [m] = await listMembers(db, code);
  assert.equal(m.name, "Mei");
  assert.deepEqual(m.cuisines, ["korean"]);
  assert.deepEqual(m.dietary, ["vegan"]);
  assert.equal(m.notes, "hi");
});

test("upsertMember edits the existing member when the name matches, ignoring case", async () => {
  const db = createFakeD1();
  const code = await createRoom(db);
  await upsertMember(db, code, member("Mei", { area: "Bishan" }));
  await upsertMember(db, code, member("mei", { area: "Clementi" }));

  const members = await listMembers(db, code);
  assert.equal(members.length, 1);
  assert.equal(members[0].area, "Clementi");
});

test("upsertMember refuses a new member once the room is full", async () => {
  const db = createFakeD1();
  const code = await createRoom(db);
  for (let i = 0; i < MAX_MEMBERS; i++) {
    assert.deepEqual(await upsertMember(db, code, member(`P${i}`)), { ok: true });
  }

  const result = await upsertMember(db, code, member("One too many"));
  assert.match(result.error, /full/);
  assert.equal((await listMembers(db, code)).length, MAX_MEMBERS);
});

test("a full room still lets an existing member edit their details", async () => {
  const db = createFakeD1();
  const code = await createRoom(db);
  for (let i = 0; i < MAX_MEMBERS; i++) await upsertMember(db, code, member(`P${i}`));

  const result = await upsertMember(db, code, member("P3", { area: "Tampines" }));
  assert.deepEqual(result, { ok: true });
});

const PICK = { rank: 1, name: "Place A", times: [{ name: "Mei", minutes: 20, estimated: false }] };

test("listShortlists returns the newest first, with picks and unlocated parsed back", async () => {
  const db = createFakeD1();
  const code = await createRoom(db);
  await addShortlist(db, code, { summary: "first", picks: [PICK], unlocated: ["Lost"] });
  await addShortlist(db, code, { summary: "could not decide" });

  const [newest, oldest] = await listShortlists(db, code);
  assert.equal(newest.summary, "could not decide");
  assert.deepEqual(newest.picks, []);
  assert.deepEqual(newest.unlocated, []);
  assert.deepEqual(oldest.picks, [PICK]);
  assert.deepEqual(oldest.unlocated, ["Lost"]);
  assert.ok(newest.id > oldest.id);
});

test("members and shortlists are scoped to their own room", async () => {
  const db = createFakeD1();
  const a = await createRoom(db);
  const b = await createRoom(db);
  await upsertMember(db, a, member("Mei"));
  await addShortlist(db, a, { summary: "r", picks: [PICK] });

  assert.equal((await listMembers(db, b)).length, 0);
  assert.equal((await listShortlists(db, b)).length, 0);
});
