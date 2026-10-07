import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatMembers,
  checkDietaryConflicts,
  formatGeocode,
  withKeywords,
  formatPlaces,
  selectPlaces,
  buildCandidates,
  unverifiedNeeds,
  formatForecast,
  buildShortlist,
  toolDefinitions,
} from "../src/tools.js";

const person = (name, extra = {}) => ({
  name,
  area: "Bishan",
  cuisines: [],
  dietary: [],
  notes: "",
  ...extra,
});

// ---- formatMembers --------------------------------------------------------

test("formatMembers tallies cuisines, most votes first, with voters", () => {
  const out = formatMembers([
    person("Ah Beng", { cuisines: ["western", "korean"] }),
    person("Raj", { cuisines: ["western", "japanese"] }),
    person("Mei", { cuisines: ["japanese"] }),
  ]);
  assert.deepEqual(out.cuisine_votes, [
    { cuisine: "japanese", votes: 2, voters: ["Raj", "Mei"] },
    { cuisine: "western", votes: 2, voters: ["Ah Beng", "Raj"] },
    { cuisine: "korean", votes: 1, voters: ["Ah Beng"] },
  ]);
});

test("formatMembers drops internal fields and summarises recent shortlists", () => {
  const out = formatMembers(
    [{ ...person("Mei"), updated_at: 123 }],
    [{ id: 1, summary: "why", picks: [{ name: "Place A" }, { name: "Place B" }], unlocated: [] }],
  );
  assert.equal("updated_at" in out.members[0], false);
  assert.deepEqual(out.previous_shortlists, [{ places: ["Place A", "Place B"], summary: "why" }]);
});

test("formatMembers keeps only the three most recent shortlists", () => {
  const shortlists = [1, 2, 3, 4, 5].map((i) => ({ id: i, summary: `s${i}`, picks: [], unlocated: [] }));
  assert.equal(formatMembers([], shortlists).previous_shortlists.length, 3);
});

test("formatMembers copes with an empty poll", () => {
  assert.deepEqual(formatMembers([]), {
    members: [],
    cuisine_votes: [],
    previous_shortlists: [],
  });
});

// ---- checkDietaryConflicts ------------------------------------------------

test("checkDietaryConflicts collects who holds each hard constraint", () => {
  const out = checkDietaryConflicts([
    person("Raj", { dietary: ["halal"] }),
    person("Mei", { dietary: ["vegetarian", "no_shellfish"] }),
    person("Ah Beng"),
  ]);
  assert.deepEqual(out.hard_constraints, {
    halal: ["Raj"],
    vegetarian: ["Mei"],
    no_shellfish: ["Mei"],
  });
  assert.deepEqual(out.search_keywords, ["halal", "vegetarian"]);
  assert.deepEqual(out.avoid, ["shellfish"]);
  assert.deepEqual(out.warnings, []);
});

test("vegan wins over vegetarian as the search keyword", () => {
  const out = checkDietaryConflicts([
    person("A", { dietary: ["vegetarian"] }),
    person("B", { dietary: ["vegan"] }),
  ]);
  assert.deepEqual(out.search_keywords, ["vegan"]);
});

test("no_beef, no_shellfish and nut_allergy are things to avoid, not to search for", () => {
  const out = checkDietaryConflicts([
    person("A", { dietary: ["no_beef", "nut_allergy"] }),
    person("B", { dietary: ["no_shellfish"] }),
  ]);
  assert.deepEqual(out.search_keywords, []);
  assert.deepEqual(out.avoid, ["beef", "shellfish", "nuts"]);
});

test("flags a member whose only pick clashes with someone else's constraint", () => {
  const out = checkDietaryConflicts([
    person("Mei", { dietary: ["vegan"], cuisines: ["japanese"] }),
    person("Ah Beng", { cuisines: ["steakhouse"] }),
  ]);
  assert.equal(out.warnings.length, 1);
  assert.match(out.warnings[0], /Ah Beng only picked steakhouse/);
  assert.match(out.warnings[0], /Mei \(vegan\)/);
});

test("a seafood-only pick clashes with no_shellfish", () => {
  const out = checkDietaryConflicts([
    person("Marcus", { dietary: ["no_shellfish"] }),
    person("Ah Beng", { cuisines: ["seafood"] }),
  ]);
  assert.match(out.warnings[0], /Marcus \(no_shellfish\)/);
});

test("does not flag a member who has at least one compatible pick", () => {
  const out = checkDietaryConflicts([
    person("Mei", { dietary: ["vegan"] }),
    person("Ah Beng", { cuisines: ["steakhouse", "japanese"] }),
  ]);
  assert.deepEqual(out.warnings, []);
});

test("does not flag a clash with the member's own constraint", () => {
  const out = checkDietaryConflicts([
    person("Mei", { dietary: ["vegan"], cuisines: ["steakhouse"] }),
  ]);
  assert.deepEqual(out.warnings, []);
});

test("returns empty results for an empty poll", () => {
  assert.deepEqual(checkDietaryConflicts([]), {
    hard_constraints: {},
    search_keywords: [],
    avoid: [],
    warnings: [],
  });
});

// ---- geocode and query ----------------------------------------------------

test("formatGeocode returns the first result's coordinates", () => {
  const payload = { places: [{ location: { latitude: 1.3, longitude: 103.9 } }] };
  assert.deepEqual(formatGeocode(payload), { latitude: 1.3, longitude: 103.9 });
});

test("formatGeocode returns null when nothing usable came back", () => {
  assert.equal(formatGeocode({}), null);
  assert.equal(formatGeocode({ places: [] }), null);
  assert.equal(formatGeocode({ places: [{ location: { latitude: "1" } }] }), null);
  assert.equal(formatGeocode(null), null);
});

test("withKeywords appends dietary keywords the query does not already have", () => {
  assert.equal(withKeywords("indian", ["halal", "vegetarian"]), "indian halal vegetarian");
  assert.equal(withKeywords("Halal indian", ["halal"]), "Halal indian");
  assert.equal(withKeywords("  thai ", []), "thai");
});

// ---- formatPlaces / selectPlaces ------------------------------------------

const ORIGIN = { latitude: 1.3, longitude: 103.85 };

test("formatPlaces shapes a Places result", () => {
  const [place] = formatPlaces(
    [
      {
        displayName: { text: "Good Diner" },
        formattedAddress: "1 Road",
        rating: 4.4,
        priceLevel: "PRICE_LEVEL_MODERATE",
        location: { latitude: 1.3, longitude: 103.85 },
        currentOpeningHours: { openNow: true },
        servesVegetarianFood: true,
      },
    ],
    ORIGIN,
  );
  assert.deepEqual(place, {
    name: "Good Diner",
    address: "1 Road",
    rating: 4.4,
    price_level: "PRICE_LEVEL_MODERATE",
    open_now: true,
    serves_vegetarian_food: true,
    location: { latitude: 1.3, longitude: 103.85 },
    distance_m: 0,
  });
});

test("formatPlaces fills gaps with null instead of guessing", () => {
  const [place] = formatPlaces([{}], ORIGIN);
  assert.equal(place.name, "Unnamed");
  assert.equal(place.rating, null);
  assert.equal(place.location, null);
  assert.equal(place.distance_m, null);
  assert.equal(place.open_now, null);
  assert.equal(place.serves_vegetarian_food, null);
});

const spot = (name, distance_m, extra = {}) => ({
  name,
  distance_m,
  location: { latitude: 1.3, longitude: 103.8 },
  serves_vegetarian_food: null,
  ...extra,
});

test("selectPlaces drops places with no location", () => {
  const out = selectPlaces([spot("A", 10), spot("B", 20, { location: null })], {}, 10);
  assert.deepEqual(out.map((p) => p.name), ["A"]);
});

test("selectPlaces drops a place that says it has no vegetarian food when someone needs it", () => {
  const places = [spot("Steak", 10, { serves_vegetarian_food: false }), spot("Unknown", 20), spot("Veg", 30, { serves_vegetarian_food: true })];
  assert.deepEqual(selectPlaces(places, { vegetarian: ["Mei"] }, 10).map((p) => p.name), ["Unknown", "Veg"]);
  assert.deepEqual(selectPlaces(places, { vegan: ["Mei"] }, 10).map((p) => p.name), ["Unknown", "Veg"]);
});

test("selectPlaces keeps non-vegetarian places when nobody needs vegetarian", () => {
  const places = [spot("Steak", 10, { serves_vegetarian_food: false })];
  assert.equal(selectPlaces(places, { halal: ["Raj"] }, 10).length, 1);
});

test("selectPlaces keeps the closest to the midpoint, up to the limit", () => {
  const out = selectPlaces([spot("Far", 900), spot("Near", 100), spot("Mid", 500)], {}, 2);
  assert.deepEqual(out.map((p) => p.name), ["Near", "Mid"]);
});

// ---- buildCandidates / unverifiedNeeds ------------------------------------

const ORIGINS = [
  { name: "Aisha", latitude: 1.3, longitude: 103.85 },
  { name: "Wei Jie", latitude: 1.3, longitude: 103.7 },
];

test("buildCandidates attaches times, a summary and unverified needs, and hides coordinates", () => {
  const places = [spot("Near", 100, { location: { latitude: 1.3, longitude: 103.85 } })];
  const [c] = buildCandidates(places, ORIGINS, new Map([["0:0", 10], ["1:0", 30]]), { halal: ["Aisha"] });

  assert.equal(c.name, "Near");
  assert.deepEqual(c.times, [
    { name: "Aisha", minutes: 10, estimated: false },
    { name: "Wei Jie", minutes: 30, estimated: false },
  ]);
  assert.deepEqual(c.longest, { name: "Wei Jie", minutes: 30 });
  assert.equal(c.total_min, 40);
  assert.deepEqual(c.unverified_needs, ["halal"]);
  assert.equal("location" in c, false);
  assert.equal("distance_m" in c, false);
});

test("buildCandidates uses each place's own destination index for the matrix", () => {
  const places = [spot("A", 1), spot("B", 2)];
  const parsed = new Map([["0:0", 5], ["1:0", 5], ["0:1", 50], ["1:1", 50]]);
  const [a, b] = buildCandidates(places, ORIGINS, parsed, {});
  assert.equal(a.longest.minutes, 5);
  assert.equal(b.longest.minutes, 50);
});

test("unverifiedNeeds lists every need Google cannot confirm", () => {
  const holders = {
    halal: ["A"],
    vegan: ["B"],
    no_beef: ["C"],
    no_shellfish: ["D"],
    nut_allergy: ["E"],
  };
  assert.deepEqual(unverifiedNeeds(holders, {}), [
    "halal",
    "no_beef",
    "no_shellfish",
    "nut_allergy",
    "vegan",
  ]);
});

test("vegetarian is confirmed only when Google says the place serves it", () => {
  const holders = { vegetarian: ["Mei"] };
  assert.deepEqual(unverifiedNeeds(holders, { serves_vegetarian_food: true }), []);
  assert.deepEqual(unverifiedNeeds(holders, { serves_vegetarian_food: null }), ["vegetarian"]);
});

test("unverifiedNeeds is empty when nobody has a dietary need", () => {
  assert.deepEqual(unverifiedNeeds({}, {}), []);
});

// ---- formatForecast -------------------------------------------------------

const FORECAST = {
  data: {
    items: [
      {
        valid_period: { text: "1 pm to 3 pm" },
        forecasts: [
          { area: "Bishan", forecast: "Thundery Showers" },
          { area: "Kallang", forecast: "Cloudy" },
        ],
      },
    ],
  },
};

test("formatForecast finds an area ignoring case", () => {
  assert.deepEqual(formatForecast(FORECAST, "bishan"), {
    area: "bishan",
    forecast: "Thundery Showers",
    valid_period: "1 pm to 3 pm",
  });
});

test("formatForecast says Unknown for an area it does not have", () => {
  assert.equal(formatForecast(FORECAST, "Narnia").forecast, "Unknown");
});

test("formatForecast reports an empty payload as an error", () => {
  assert.deepEqual(formatForecast({}, "Bishan"), { error: "No forecast available" });
});

// ---- buildShortlist -------------------------------------------------------

function candidates() {
  const make = (id, name, minutes) => [
    id,
    {
      id,
      name,
      address: `${name} Road`,
      rating: 4,
      price_level: "PRICE_LEVEL_MODERATE",
      open_now: true,
      serves_vegetarian_food: true,
      times: [{ name: "Aisha", minutes, estimated: false }],
      longest: { name: "Aisha", minutes },
      total_min: minutes,
      long_trip: false,
      unverified_needs: ["halal"],
    },
  ];
  return new Map([make("p1", "Alpha", 20), make("p2", "Bravo", 30), make("p3", "Charlie", 40), make("p4", "Delta", 50)]);
}

test("buildShortlist keeps the model's order and takes facts from the candidate", () => {
  const out = buildShortlist(
    [
      { id: "p2", reason: "Closest to Aisha" },
      { id: "p1", reason: "Cheaper" },
    ],
    "  I settle this one.  ",
    candidates(),
  );
  assert.equal(out.error, undefined);
  assert.equal(out.summary, "I settle this one.");
  assert.deepEqual(out.picks.map((p) => [p.rank, p.name]), [[1, "Bravo"], [2, "Alpha"]]);
  assert.deepEqual(out.picks[0].longest, { name: "Aisha", minutes: 30 });
  assert.deepEqual(out.picks[0].unverified_needs, ["halal"]);
  assert.equal(out.picks[0].reason, "Closest to Aisha");
});

test("buildShortlist ignores names and times the model tries to supply", () => {
  const out = buildShortlist(
    [{ id: "p1", reason: "ok", name: "Made Up Cafe", times: [{ name: "Aisha", minutes: 1 }], longest: { minutes: 1 } }],
    "s",
    candidates(),
  );
  assert.equal(out.picks[0].name, "Alpha");
  assert.equal(out.picks[0].longest.minutes, 20);
});

test("buildShortlist rejects an id that find_candidates never returned", () => {
  const out = buildShortlist([{ id: "p99", reason: "x" }], "s", candidates());
  assert.match(out.error, /Unknown candidate id: p99/);
});

test("buildShortlist rejects duplicate ids", () => {
  const out = buildShortlist([{ id: "p1", reason: "x" }, { id: "p1", reason: "y" }], "s", candidates());
  assert.match(out.error, /Duplicate/);
});

test("buildShortlist accepts one to three places only", () => {
  assert.match(buildShortlist([], "s", candidates()).error, /1 to 3/);
  assert.match(buildShortlist("p1", "s", candidates()).error, /1 to 3/);
  const four = ["p1", "p2", "p3", "p4"].map((id) => ({ id, reason: "x" }));
  assert.match(buildShortlist(four, "s", candidates()).error, /1 to 3/);
  assert.equal(buildShortlist(four.slice(0, 3), "s", candidates()).error, undefined);
});

test("buildShortlist needs a reason for every place and a summary", () => {
  assert.match(buildShortlist([{ id: "p1", reason: "  " }], "s", candidates()).error, /reason/);
  assert.match(buildShortlist([{ id: "p1" }], "s", candidates()).error, /reason/);
  assert.match(buildShortlist([{ id: "p1", reason: "x" }], "", candidates()).error, /summary/);
  assert.match(buildShortlist([{ id: "p1", reason: "x" }], 5, candidates()).error, /summary/);
});

test("buildShortlist caps long text", () => {
  const out = buildShortlist([{ id: "p1", reason: "r".repeat(500) }], "s".repeat(1200), candidates());
  assert.equal(out.picks[0].reason.length, 300);
  assert.equal(out.summary.length, 900);
});

test("buildShortlist rejects null entries without throwing", () => {
  assert.match(buildShortlist([null], "s", candidates()).error, /Unknown candidate/);
});

// ---- definitions ----------------------------------------------------------

test("the five tools have a name, a description and an object schema", () => {
  assert.deepEqual(toolDefinitions.map((t) => t.function.name), [
    "read_votes",
    "locate_members",
    "find_candidates",
    "get_rain_forecast",
    "write_shortlist",
  ]);
  for (const t of toolDefinitions) {
    assert.ok(t.function.description.length > 0);
    assert.equal(t.function.parameters.type, "object");
  }
});

test("write_shortlist asks for a spoken verdict in full sentences, not a list", () => {
  const tool = toolDefinitions.find((t) => t.function.name === "write_shortlist");
  const { picks, summary } = tool.function.parameters.properties;
  assert.match(summary.description, /say it aloud/);
  assert.match(summary.description, /full sentences/);
  assert.match(summary.description, /No bullet points, lists or sentence fragments/);
  assert.match(picks.items.properties.reason.description, /full sentences/);
});

test("no tool lets the model pass coordinates or travel times", () => {
  for (const t of toolDefinitions) {
    const props = Object.keys(t.function.parameters.properties);
    for (const forbidden of ["latitude", "longitude", "times", "minutes"]) {
      assert.equal(props.includes(forbidden), false, `${t.function.name} accepts ${forbidden}`);
    }
  }
});
