import { test, mock } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { addShortlist } from "../src/db.js";
import { createFakeD1 } from "../test-support/fake-d1.mjs";
import { stubFetch, textCompletion, toolCompletion } from "../test-support/fetch-stub.mjs";
import { world } from "../test-support/world.mjs";

function makeEnv(extra = {}) {
  return {
    DB: createFakeD1(),
    OPENCODE_API_KEY: "llm-key",
    GOOGLE_PLACES_API_KEY: "places-key",
    ...extra,
  };
}

function call(env, method, path, body) {
  const init = { method };
  if (body !== undefined) {
    init.body = typeof body === "string" ? body : JSON.stringify(body);
    init.headers = { "content-type": "application/json" };
  }
  return worker.fetch(new Request(`http://localhost${path}`, init), env);
}

async function createRoomVia(env) {
  const res = await call(env, "POST", "/api/rooms");
  return (await res.json()).code;
}

const MEI = { name: "Mei", area: "Bishan", cuisines: ["indian"], dietary: ["vegetarian"] };

function quietLogs(t) {
  mock.method(console, "log", () => {});
  mock.method(console, "error", () => {});
  t.after(() => mock.restoreAll());
}

// A room with Mei in it, ready to decide.
async function roomWithMei() {
  const env = makeEnv();
  const code = await createRoomVia(env);
  await call(env, "PUT", `/api/rooms/${code}/members`, MEI);
  return { env, code };
}

test("GET / serves the page", async () => {
  const res = await call(makeEnv(), "GET", "/");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
  assert.match(await res.text(), /Da Jia Chi/);
});

test("unknown paths return 404", async () => {
  assert.equal((await call(makeEnv(), "GET", "/nope")).status, 404);
  assert.equal((await call(makeEnv(), "DELETE", "/")).status, 404);
});

test("POST /api/rooms creates a room with a valid code", async () => {
  const res = await call(makeEnv(), "POST", "/api/rooms");
  assert.equal(res.status, 201);
  assert.match((await res.json()).code, /^[A-HJ-NP-Z2-9]{5}$/);
});

test("GET /api/rooms/:code returns an empty room", async () => {
  const env = makeEnv();
  const code = await createRoomVia(env);
  const res = await call(env, "GET", `/api/rooms/${code}`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { code, members: [], shortlists: [] });
});

test("room codes are case-insensitive", async () => {
  const env = makeEnv();
  const code = await createRoomVia(env);
  const res = await call(env, "GET", `/api/rooms/${code.toLowerCase()}`);
  assert.equal(res.status, 200);
});

test("unknown or malformed room codes return 404", async () => {
  const env = makeEnv();
  assert.equal((await call(env, "GET", "/api/rooms/ZZZZZ")).status, 404);
  assert.equal((await call(env, "GET", "/api/rooms/bad")).status, 404);
  assert.equal((await call(env, "PUT", "/api/rooms/ZZZZZ/members", MEI)).status, 404);
  assert.equal((await call(env, "POST", "/api/rooms/ZZZZZ/decide")).status, 404);
});

test("PUT members adds a member who then shows up in the room", async () => {
  const env = makeEnv();
  const code = await createRoomVia(env);

  const put = await call(env, "PUT", `/api/rooms/${code}/members`, MEI);
  assert.equal(put.status, 200);

  const room = await (await call(env, "GET", `/api/rooms/${code}`)).json();
  assert.equal(room.members.length, 1);
  assert.equal(room.members[0].name, "Mei");
  assert.deepEqual(room.members[0].dietary, ["vegetarian"]);
});

test("PUT members accepts the new dietary options", async () => {
  const env = makeEnv();
  const code = await createRoomVia(env);
  const res = await call(env, "PUT", `/api/rooms/${code}/members`, {
    ...MEI,
    dietary: ["no_shellfish", "nut_allergy", "vegan"],
  });
  assert.equal(res.status, 200);
});

test("PUT members rejects the removed no_seafood option and other unknown values", async () => {
  const env = makeEnv();
  const code = await createRoomVia(env);
  for (const bad of ["no_seafood", "keto"]) {
    const res = await call(env, "PUT", `/api/rooms/${code}/members`, { ...MEI, dietary: [bad] });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /dietary/);
  }
});

test("PUT members rejects a non-JSON body with 400", async () => {
  const env = makeEnv();
  const code = await createRoomVia(env);
  const res = await call(env, "PUT", `/api/rooms/${code}/members`, "not json");
  assert.equal(res.status, 400);
});

test("PUT members returns 409 once the room has 10 members", async () => {
  const env = makeEnv();
  const code = await createRoomVia(env);
  for (let i = 0; i < 10; i++) {
    const res = await call(env, "PUT", `/api/rooms/${code}/members`, { ...MEI, name: `P${i}` });
    assert.equal(res.status, 200);
  }
  const res = await call(env, "PUT", `/api/rooms/${code}/members`, { ...MEI, name: "Late" });
  assert.equal(res.status, 409);
});

test("decide returns 503 when an API key is missing", async () => {
  const env = makeEnv({ GOOGLE_PLACES_API_KEY: undefined });
  const code = await createRoomVia(env);
  await call(env, "PUT", `/api/rooms/${code}/members`, MEI);
  const res = await call(env, "POST", `/api/rooms/${code}/decide`);
  assert.equal(res.status, 503);
});

test("decide returns 400 for an empty room", async () => {
  const env = makeEnv();
  const code = await createRoomVia(env);
  const res = await call(env, "POST", `/api/rooms/${code}/decide`);
  assert.equal(res.status, 400);
});

test("decide validates the objection", async () => {
  const { env, code } = await roomWithMei();

  const long = await call(env, "POST", `/api/rooms/${code}/decide`, { objection: "x".repeat(301) });
  assert.equal(long.status, 400);
  const wrongType = await call(env, "POST", `/api/rooms/${code}/decide`, { objection: 5 });
  assert.equal(wrongType.status, 400);
  const notJson = await call(env, "POST", `/api/rooms/${code}/decide`, "nope");
  assert.equal(notJson.status, 400);
});

test("decide runs the whole tool loop and the shortlist shows up for the whole room", async (t) => {
  quietLogs(t);
  const { env, code } = await roomWithMei();
  const stub = stubFetch(
    world((c, n) => {
      if (n === 1) return toolCompletion(["find_candidates", { query: "indian" }]);
      if (n === 2) {
        return toolCompletion([
          "write_shortlist",
          { picks: [{ id: "p1", reason: "Shortest trip." }], summary: "I settle this one." },
        ]);
      }
      return textCompletion("Done lah.");
    }),
  );
  t.after(stub.restore);

  const res = await call(env, "POST", `/api/rooms/${code}/decide`);

  assert.equal(res.status, 200);
  assert.equal((await res.json()).reply, "Done lah.");
  const room = await (await call(env, "GET", `/api/rooms/${code}`)).json();
  assert.equal(room.shortlists.length, 1);
  assert.equal(room.shortlists[0].summary, "I settle this one.");
  assert.equal(room.shortlists[0].picks.length, 1);
  assert.equal(room.shortlists[0].picks[0].rank, 1);
  assert.equal(room.shortlists[0].picks[0].times[0].name, "Mei");
});

test("decide records an explanation-only shortlist when the model writes none", async (t) => {
  quietLogs(t);
  const { env, code } = await roomWithMei();
  const stub = stubFetch(world(() => textCompletion("Nothing fits Mei, sorry.")));
  t.after(stub.restore);

  await call(env, "POST", `/api/rooms/${code}/decide`);

  const room = await (await call(env, "GET", `/api/rooms/${code}`)).json();
  assert.equal(room.shortlists.length, 1);
  assert.deepEqual(room.shortlists[0].picks, []);
  assert.equal(room.shortlists[0].summary, "Nothing fits Mei, sorry.");
});

test("an objection is passed to the model as the user message", async (t) => {
  quietLogs(t);
  const { env, code } = await roomWithMei();
  const stub = stubFetch(world(() => textCompletion("ok")));
  t.after(stub.restore);

  await call(env, "POST", `/api/rooms/${code}/decide`, { objection: "nothing Western" });

  const user = stub.calls[0].body.messages.find((m) => m.role === "user");
  assert.match(user.content, /nothing Western/);
});

test("decide is rate limited per room", async (t) => {
  quietLogs(t);
  const { env, code } = await roomWithMei();
  await addShortlist(env.DB, code, { summary: "Just now" });
  const stub = stubFetch(() => textCompletion("should not be called"));
  t.after(stub.restore);

  const res = await call(env, "POST", `/api/rooms/${code}/decide`);

  assert.equal(res.status, 429);
  assert.equal(stub.calls.length, 0);
});

test("decide returns 504 when the LLM call times out", async (t) => {
  quietLogs(t);
  const { env, code } = await roomWithMei();
  const stub = stubFetch(() => {
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  });
  t.after(stub.restore);

  const res = await call(env, "POST", `/api/rooms/${code}/decide`);

  assert.equal(res.status, 504);
  assert.match((await res.json()).error, /too long/);
});

test("decide returns 500 with a friendly message when the LLM fails", async (t) => {
  quietLogs(t);
  const { env, code } = await roomWithMei();
  const stub = stubFetch(() => new Response("boom", { status: 502 }));
  t.after(stub.restore);

  const res = await call(env, "POST", `/api/rooms/${code}/decide`);

  assert.equal(res.status, 500);
  assert.match((await res.json()).error, /cannot think/);
});

// ---- tone -----------------------------------------------------------------

import { TONES } from "../src/prompt.js";

const systemPromptOf = (stub) => stub.calls[0].body.messages.find((m) => m.role === "system").content;

test("decide uses the Singlish referee when no tone is given", async (t) => {
  quietLogs(t);
  const { env, code } = await roomWithMei();
  const stub = stubFetch(world(() => textCompletion("ok")));
  t.after(stub.restore);

  await call(env, "POST", `/api/rooms/${code}/decide`);

  assert.match(systemPromptOf(stub), /I settle this one, no more arguing/);
});

test("decide passes the chosen tone to the model", async (t) => {
  quietLogs(t);
  for (const [tone, marker] of [
    ["professional", /No slang, no jokes/],
    ["uncle", /A bit impatient/],
    ["singlish", /I settle this one/],
  ]) {
    const { env, code } = await roomWithMei();
    const stub = stubFetch(world(() => textCompletion("ok")));

    const res = await call(env, "POST", `/api/rooms/${code}/decide`, { tone });
    stub.restore();

    assert.equal(res.status, 200, tone);
    assert.match(systemPromptOf(stub), marker, tone);
    // Whatever the tone, the dietary rules stay in the prompt.
    assert.match(systemPromptOf(stub), /Dietary constraints are hard rules/, tone);
  }
});

test("decide rejects a tone that does not exist, before calling the model", async (t) => {
  quietLogs(t);
  const { env, code } = await roomWithMei();
  const stub = stubFetch(() => textCompletion("should not be called"));
  t.after(stub.restore);

  for (const tone of ["pirate", "", 5, null, ["uncle"], "constructor"]) {
    const res = await call(env, "POST", `/api/rooms/${code}/decide`, { tone });
    assert.equal(res.status, 400, `tone ${JSON.stringify(tone)}`);
    assert.match((await res.json()).error, /tone must be one of: singlish, professional, uncle/);
  }
  assert.equal(stub.calls.length, 0);
});

test("a rejected tone does not use up the poll's cooldown", async (t) => {
  quietLogs(t);
  const { env, code } = await roomWithMei();
  const stub = stubFetch(world(() => textCompletion("ok")));
  t.after(stub.restore);

  await call(env, "POST", `/api/rooms/${code}/decide`, { tone: "pirate" });
  const res = await call(env, "POST", `/api/rooms/${code}/decide`, { tone: "uncle" });

  assert.equal(res.status, 200);
});

test("the page offers exactly the tones the server accepts", async () => {
  const html = await (await call(makeEnv(), "GET", "/")).text();
  const offered = [...html.matchAll(/<option value="([^"]+)">([^<]+)<\/option>/g)];
  const known = offered.filter(([, value]) => value in TONES);

  assert.deepEqual(known.map(([, value]) => value), Object.keys(TONES));
  assert.deepEqual(known.map(([, , label]) => label), Object.values(TONES).map((t) => t.label));
  assert.match(html, /tone: \$\("tone"\)\.value/);
});
