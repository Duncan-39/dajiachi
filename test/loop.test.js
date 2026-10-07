import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { runLoop } from "../src/loop.js";
import { createRoom, upsertMember, listShortlists } from "../src/db.js";
import { estimateMinutes, haversineMetres } from "../src/travel.js";
import { createFakeD1 } from "../test-support/fake-d1.mjs";
import { stubFetch, jsonResponse, textCompletion, toolCompletion } from "../test-support/fetch-stub.mjs";
import { world, AREA_POINTS } from "../test-support/world.mjs";

const isLlm = (call) => call.url.endsWith("/chat/completions");
const isRoutes = (call) => call.url.includes("routes.googleapis.com");
const isSearch = (call) => call.url.includes("places.googleapis.com") && call.body.pageSize !== 1;
const isGeocode = (call) => call.url.includes("places.googleapis.com") && call.body.pageSize === 1;

// runLoop logs each tool call; keep test output clean.
function quietLogs(t) {
  mock.method(console, "log", () => {});
  t.after(() => mock.restoreAll());
}

const person = (name, area, extra = {}) => ({ name, area, cuisines: [], dietary: [], notes: "", ...extra });

// Ah Beng (Pasir Ris) and Mei (Boon Lay, vegetarian), far apart on purpose.
async function setup(members = [person("Ah Beng", "Pasir Ris", { cuisines: ["indian"] }), person("Mei", "Boon Lay", { cuisines: ["indian"], dietary: ["vegetarian"] })]) {
  const DB = createFakeD1();
  const room = await createRoom(DB);
  for (const m of members) await upsertMember(DB, room, m);
  const env = { DB, OPENCODE_API_KEY: "llm-key", GOOGLE_PLACES_API_KEY: "places-key" };
  return { env, room, DB };
}

// An LLM that runs the given tool-call rounds, then gives a final reply.
const script = (...rounds) => (call, n) =>
  n <= rounds.length ? toolCompletion(...rounds[n - 1]) : textCompletion("Done.");

// What the model sees as the result of its nth tool round.
const toolResult = (stub, llmCallNumber) => {
  const llmCalls = stub.calls.filter(isLlm);
  return JSON.parse(llmCalls[llmCallNumber].body.messages.at(-1).content);
};

test("returns the model's reply when no tools are needed", async (t) => {
  quietLogs(t);
  const { env, room } = await setup();
  const stub = stubFetch(world(() => textCompletion("I cannot tell yet lah.")));
  t.after(stub.restore);

  const out = await runLoop("Go", env, room);

  assert.deepEqual(out, { reply: "I cannot tell yet lah.", shortlist: null });
  assert.equal(stub.calls.length, 1);
});

test("sends the bearer key, a session id and the five tools", async (t) => {
  quietLogs(t);
  const { env, room } = await setup();
  const stub = stubFetch(world(() => textCompletion("ok")));
  t.after(stub.restore);

  await runLoop("Go", env, room);

  const [call] = stub.calls;
  assert.equal(call.init.headers.authorization, "Bearer llm-key");
  assert.ok(call.init.headers["x-opencode-session"]);
  assert.equal(call.body.tools.length, 5);
});

test("read_votes returns members, the tally and the dietary summary", async (t) => {
  quietLogs(t);
  const { env, room } = await setup();
  const stub = stubFetch(world(script([["read_votes", {}]])));
  t.after(stub.restore);

  await runLoop("Go", env, room);

  const result = toolResult(stub, 1);
  assert.deepEqual(result.members.map((m) => m.name), ["Ah Beng", "Mei"]);
  assert.deepEqual(result.cuisine_votes[0], { cuisine: "indian", votes: 2, voters: ["Ah Beng", "Mei"] });
  assert.deepEqual(result.dietary_summary.search_keywords, ["vegetarian"]);
});

test("locate_members geocodes each distinct area once and reports the midpoint and spread", async (t) => {
  quietLogs(t);
  const { env, room, DB } = await setup();
  await upsertMember(DB, room, person("Raj", "boon lay"));
  const stub = stubFetch(world(script([["locate_members", {}]])));
  t.after(stub.restore);

  await runLoop("Go", env, room);

  assert.equal(stub.calls.filter(isGeocode).length, 2);
  const result = toolResult(stub, 1);
  // Two of three people are in Boon Lay, so the midpoint leans west.
  const expected = (AREA_POINTS["pasir ris"].longitude + 2 * AREA_POINTS["boon lay"].longitude) / 3;
  assert.ok(Math.abs(result.midpoint.longitude - expected) < 0.0001);
  assert.ok(result.spread_m > 25000, `spread ${result.spread_m}`);
  assert.deepEqual(result.unlocated, []);
});

test("locate_members lists members whose area cannot be found", async (t) => {
  quietLogs(t);
  const { env, room, DB } = await setup();
  await upsertMember(DB, room, person("Lost", "Atlantis"));
  const stub = stubFetch(world(script([["locate_members", {}]])));
  t.after(stub.restore);

  await runLoop("Go", env, room);

  const result = toolResult(stub, 1);
  assert.deepEqual(result.unlocated, ["Lost"]);
  assert.deepEqual(result.located.map((m) => m.name), ["Ah Beng", "Mei"]);
});

test("locate_members fails clearly when nobody can be located", async (t) => {
  quietLogs(t);
  const { env, room } = await setup([person("Lost", "Atlantis")]);
  const stub = stubFetch(world(script([["locate_members", {}]])));
  t.after(stub.restore);

  await runLoop("Go", env, room);

  assert.match(toolResult(stub, 1).error, /Could not locate/);
});

test("find_candidates searches near the midpoint with a scaled radius and the dietary keyword", async (t) => {
  quietLogs(t);
  const { env, room } = await setup();
  const stub = stubFetch(world(script([["find_candidates", { query: "indian" }]])));
  t.after(stub.restore);

  await runLoop("Go", env, room);

  const search = stub.calls.find(isSearch);
  assert.equal(search.body.textQuery, "indian vegetarian");
  assert.equal(search.body.openNow, true);
  // The two areas are about 27 km apart, so the radius hits the 5 km cap.
  assert.equal(search.body.locationBias.circle.radius, 5000);
  assert.ok(Math.abs(search.body.locationBias.circle.center.latitude - 1.3555) < 0.001);
  assert.equal(search.init.headers["X-Goog-Api-Key"], "places-key");
});

test("find_candidates ranks by shortest longest trip and uses the matrix times", async (t) => {
  quietLogs(t);
  const { env, room } = await setup();
  const stub = stubFetch(world(script([["find_candidates", { query: "indian" }]])));
  t.after(stub.restore);

  await runLoop("Go", env, room);

  const result = toolResult(stub, 1);
  // Dud is dropped (no vegetarian food). Longest trips: Charlie 36, Alpha 45, Bravo 50.
  assert.deepEqual(result.candidates.map((c) => c.name), ["Charlie", "Alpha", "Bravo"]);
  assert.deepEqual(result.candidates.map((c) => c.id), ["p1", "p2", "p3"]);
  assert.deepEqual(result.candidates[0].times, [
    { name: "Ah Beng", minutes: 35, estimated: false },
    { name: "Mei", minutes: 36, estimated: false },
  ]);
  assert.deepEqual(result.candidates[0].longest, { name: "Mei", minutes: 36 });
  assert.equal(result.group_spread_m > 25000, true);
});

test("find_candidates returns only the eight fairest places, but still ranks all of them", async (t) => {
  quietLogs(t);
  const { env, room } = await setup([person("Ah Beng", "Pasir Ris"), person("Mei", "Boon Lay")]);
  // Twelve places in a line; the further down the list, the longer the trip.
  const twelve = Array.from({ length: 12 }, (_, i) => ({
    id: `id-${i}`,
    displayName: { text: `Place ${String(i).padStart(2, "0")}` },
    location: { latitude: 1.3555 + i * 0.001, longitude: 103.8275 },
  }));
  const stub = stubFetch(world(script([["find_candidates", { query: "any" }]]), { places: twelve }));
  t.after(stub.restore);

  await runLoop("Go", env, room);

  const { candidates } = toolResult(stub, 1);
  assert.equal(candidates.length, 8);
  assert.deepEqual(candidates.map((c) => c.id), ["p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8"]);
  assert.equal(candidates[0].name, "Place 00");
  assert.equal(candidates[7].name, "Place 07");
  // All twelve went into the transit matrix, then only the best eight came back.
  assert.equal(stub.calls.find(isRoutes).body.destinations.length, 12);
});

test("find_candidates asks Routes for transit and never sends coordinates the model chose", async (t) => {
  quietLogs(t);
  const { env, room } = await setup();
  const stub = stubFetch(
    world(script([["find_candidates", { query: "indian", latitude: 9, longitude: 9 }]])),
  );
  t.after(stub.restore);

  await runLoop("Go", env, room);

  const routes = stub.calls.find(isRoutes);
  assert.equal(routes.body.travelMode, "TRANSIT");
  assert.equal(routes.body.origins.length, 2);
  assert.equal(routes.body.destinations.length, 3);
  assert.equal(routes.init.headers["X-Goog-FieldMask"], "originIndex,destinationIndex,duration,condition,status");
  const search = stub.calls.find(isSearch);
  assert.notEqual(search.body.locationBias.circle.center.latitude, 9);
});

test("find_candidates flags what Google cannot confirm and hides coordinates", async (t) => {
  quietLogs(t);
  const { env, room } = await setup();
  const stub = stubFetch(world(script([["find_candidates", { query: "indian" }]])));
  t.after(stub.restore);

  await runLoop("Go", env, room);

  const byName = Object.fromEntries(toolResult(stub, 1).candidates.map((c) => [c.name, c]));
  // Charlie and Alpha say they serve vegetarian food; Bravo does not say.
  assert.deepEqual(byName.Charlie.unverified_needs, []);
  assert.deepEqual(byName.Bravo.unverified_needs, ["vegetarian"]);
  assert.equal("location" in byName.Charlie, false);
});

test("find_candidates falls back to labelled estimates when the Routes API is disabled", async (t) => {
  quietLogs(t);
  const { env, room } = await setup();
  const stub = stubFetch(world(script([["find_candidates", { query: "indian" }]]), { routes: "forbidden" }));
  t.after(stub.restore);

  const out = await runLoop("Go", env, room);

  assert.equal(out.reply, "Done.");
  const { candidates } = toolResult(stub, 1);
  assert.equal(candidates.length, 3);
  for (const c of candidates) {
    for (const time of c.times) {
      assert.equal(time.estimated, true);
      assert.ok(Number.isInteger(time.minutes) && time.minutes >= 5);
    }
  }
  // Estimates grow with distance: Ah Beng is far from every candidate.
  const alpha = candidates.find((c) => c.name === "Alpha");
  const expected = estimateMinutes(
    haversineMetres(AREA_POINTS["pasir ris"], { latitude: 1.3555, longitude: 103.8275 }),
  );
  assert.equal(alpha.times[0].minutes, expected);
});

test("find_candidates falls back when the Routes call itself throws", async (t) => {
  quietLogs(t);
  const { env, room } = await setup();
  const inner = world(script([["find_candidates", { query: "indian" }]]));
  const stub = stubFetch((call) => {
    if (isRoutes(call)) throw new Error("network down");
    return inner(call);
  });
  t.after(stub.restore);

  await runLoop("Go", env, room);

  assert.equal(toolResult(stub, 1).candidates[0].times[0].estimated, true);
});

test("find_candidates reports a Places failure instead of throwing", async (t) => {
  quietLogs(t);
  const { env, room } = await setup();
  const inner = world(script([["find_candidates", { query: "indian" }]]));
  const stub = stubFetch((call) => (isSearch(call) ? jsonResponse({}, 500) : inner(call)));
  t.after(stub.restore);

  await runLoop("Go", env, room);

  assert.match(toolResult(stub, 1).error, /Places API returned 500/);
});

test("find_candidates requires a query", async (t) => {
  quietLogs(t);
  const { env, room } = await setup();
  const stub = stubFetch(world(script([["find_candidates", {}]])));
  t.after(stub.restore);

  await runLoop("Go", env, room);

  assert.match(toolResult(stub, 1).error, /query is required/);
});

test("find_candidates lists unlocated members so their trips are not silently ignored", async (t) => {
  quietLogs(t);
  const { env, room, DB } = await setup();
  await upsertMember(DB, room, person("Lost", "Atlantis"));
  const stub = stubFetch(world(script([["find_candidates", { query: "indian" }]])));
  t.after(stub.restore);

  await runLoop("Go", env, room);

  const result = toolResult(stub, 1);
  assert.deepEqual(result.unlocated, ["Lost"]);
  assert.equal(result.candidates[0].times.length, 2);
});

test("write_shortlist returns picks with times from the candidates, not from the model", async (t) => {
  quietLogs(t);
  const { env, room } = await setup();
  const stub = stubFetch(
    world(
      script(
        [["find_candidates", { query: "indian" }]],
        [["write_shortlist", {
          picks: [
            { id: "p1", reason: "Fairest trips.", name: "Fake Cafe", times: [{ name: "Mei", minutes: 1 }] },
            { id: "p2", reason: "Close second." },
          ],
          summary: "I settle this one.",
        }]],
      ),
    ),
  );
  t.after(stub.restore);

  const out = await runLoop("Go", env, room);

  const saved = out.shortlist;
  assert.equal(saved.summary, "I settle this one.");
  assert.deepEqual(saved.picks.map((p) => p.name), ["Charlie", "Alpha"]);
  assert.deepEqual(saved.picks[0].longest, { name: "Mei", minutes: 36 });
  assert.equal(saved.picks[0].times[1].minutes, 36);
  assert.deepEqual(saved.picks[0].unverified_needs, []);
  assert.deepEqual(saved.unlocated, []);
});

test("a second write_shortlist replaces the first, and the loop itself writes nothing to D1", async (t) => {
  quietLogs(t);
  const { env, room, DB } = await setup();
  const stub = stubFetch(
    world(
      script(
        [["find_candidates", { query: "indian" }]],
        [["write_shortlist", { picks: [{ id: "p2", reason: "first try" }], summary: "first" }]],
        [["write_shortlist", { picks: [{ id: "p1", reason: "better" }, { id: "p2", reason: "also" }], summary: "second" }]],
      ),
    ),
  );
  t.after(stub.restore);

  const out = await runLoop("Go", env, room);

  assert.equal(out.shortlist.summary, "second");
  assert.equal(out.shortlist.picks.length, 2);
  assert.equal((await listShortlists(DB, room)).length, 0);
});

test("a valid shortlist survives the wrap-up model call failing", async (t) => {
  quietLogs(t);
  mock.method(console, "error", () => {});
  const { env, room } = await setup();
  for (const failure of [
    () => jsonResponse({ error: "boom" }, 502),
    () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    },
  ]) {
    const stub = stubFetch(
      world((call, n) => {
        if (n === 1) return toolCompletion(["find_candidates", { query: "indian" }]);
        if (n === 2) {
          return toolCompletion(["write_shortlist", { picks: [{ id: "p1", reason: "good" }], summary: "I settle this one." }]);
        }
        return failure();
      }),
    );

    const out = await runLoop("Go", env, room);
    stub.restore();

    assert.equal(out.shortlist.summary, "I settle this one.");
    assert.equal(out.reply, "I settle this one.");
  }
});

test("a model failure before any shortlist still throws", async (t) => {
  quietLogs(t);
  const { env, room } = await setup();
  const stub = stubFetch(
    world((call, n) => (n === 1 ? toolCompletion(["find_candidates", { query: "indian" }]) : jsonResponse({}, 502))),
  );
  t.after(stub.restore);

  await assert.rejects(() => runLoop("Go", env, room), /LLM returned 502/);
});

test("a rejected write_shortlist after a good one keeps the good one", async (t) => {
  quietLogs(t);
  const { env, room } = await setup();
  const stub = stubFetch(
    world(
      script(
        [["find_candidates", { query: "indian" }]],
        [["write_shortlist", { picks: [{ id: "p1", reason: "good" }], summary: "good" }]],
        [["write_shortlist", { picks: [{ id: "p99", reason: "bad" }], summary: "bad" }]],
      ),
    ),
  );
  t.after(stub.restore);

  const out = await runLoop("Go", env, room);

  assert.equal(out.shortlist.summary, "good");
});

test("write_shortlist rejects an id that was never a candidate", async (t) => {
  quietLogs(t);
  const { env, room } = await setup();
  const stub = stubFetch(
    world(
      script(
        [["find_candidates", { query: "indian" }]],
        [["write_shortlist", { picks: [{ id: "p42", reason: "x" }], summary: "s" }]],
      ),
    ),
  );
  t.after(stub.restore);

  const out = await runLoop("Go", env, room);

  assert.equal(out.shortlist, null);
  assert.match(toolResult(stub, 2).error, /Unknown candidate id: p42/);
});

test("write_shortlist before any search has no candidates to pick from", async (t) => {
  quietLogs(t);
  const { env, room } = await setup();
  const stub = stubFetch(
    world(script([["write_shortlist", { picks: [{ id: "p1", reason: "x" }], summary: "s" }]])),
  );
  t.after(stub.restore);

  const out = await runLoop("Go", env, room);

  assert.equal(out.shortlist, null);
  assert.match(toolResult(stub, 1).error, /Unknown candidate id/);
});

test("candidate ids keep counting across several searches in one run", async (t) => {
  quietLogs(t);
  const { env, room } = await setup();
  const stub = stubFetch(
    world(script([["find_candidates", { query: "indian" }]], [["find_candidates", { query: "thai" }]])),
  );
  t.after(stub.restore);

  await runLoop("Go", env, room);

  assert.deepEqual(toolResult(stub, 2).candidates.map((c) => c.id), ["p4", "p5", "p6"]);
});

test("get_rain_forecast reads the area the model asks for", async (t) => {
  quietLogs(t);
  const { env, room } = await setup();
  const stub = stubFetch(world(script([["get_rain_forecast", { area: "bishan" }]])));
  t.after(stub.restore);

  await runLoop("Go", env, room);

  assert.equal(toolResult(stub, 1).forecast, "Cloudy");
});

test("an unknown tool name returns an error result instead of throwing", async (t) => {
  quietLogs(t);
  const { env, room } = await setup();
  const stub = stubFetch(world(script([["order_pizza", {}]])));
  t.after(stub.restore);

  await runLoop("Go", env, room);

  assert.match(toolResult(stub, 1).error, /Unknown tool/);
});

test("malformed tool arguments are treated as empty", async (t) => {
  quietLogs(t);
  const { env, room } = await setup();
  const stub = stubFetch(world(script([["read_votes", "{not json"]])));
  t.after(stub.restore);

  const out = await runLoop("Go", env, room);
  assert.equal(out.reply, "Done.");
});

test("gives up after the round limit", async (t) => {
  quietLogs(t);
  const { env, room } = await setup();
  const stub = stubFetch(world(() => toolCompletion(["read_votes", {}])));
  t.after(stub.restore);

  const out = await runLoop("Go", env, room);

  assert.match(out.reply, /too many times/);
  assert.equal(stub.calls.filter(isLlm).length, 8);
});

test("throws when the LLM returns an error status", async (t) => {
  quietLogs(t);
  const { env, room } = await setup();
  const stub = stubFetch(world(() => jsonResponse({ error: "boom" }, 500)));
  t.after(stub.restore);

  await assert.rejects(() => runLoop("Go", env, room), /LLM returned 500/);
});
