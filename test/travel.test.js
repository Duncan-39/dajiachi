import { test } from "node:test";
import assert from "node:assert/strict";
import {
  haversineMetres,
  midpoint,
  spreadMetres,
  searchRadius,
  maxCandidates,
  estimateMinutes,
  buildMatrixRequest,
  parseMatrix,
  timesToDestination,
  summariseTimes,
  rankCandidates,
} from "../src/travel.js";

// ---- geometry -------------------------------------------------------------

test("haversineMetres is about 1.1 km per 0.01 degrees of latitude", () => {
  const d = haversineMetres(
    { latitude: 1.3, longitude: 103.85 },
    { latitude: 1.31, longitude: 103.85 },
  );
  assert.ok(d > 1100 && d < 1120, `got ${d}`);
});

test("midpoint averages coordinates", () => {
  assert.deepEqual(
    midpoint([
      { latitude: 1.3, longitude: 103.8 },
      { latitude: 1.4, longitude: 103.9 },
    ]),
    { latitude: 1.35, longitude: 103.85 },
  );
});

test("midpoint of one point is that point", () => {
  assert.deepEqual(midpoint([{ latitude: 1.3521, longitude: 103.8198 }]), {
    latitude: 1.3521,
    longitude: 103.8198,
  });
});

test("midpoint counts each point once, so repeated areas pull it their way", () => {
  const mid = midpoint([
    { latitude: 1.3, longitude: 103.7 },
    { latitude: 1.3, longitude: 103.7 },
    { latitude: 1.3, longitude: 103.9 },
  ]);
  assert.equal(mid.longitude, 103.76667);
});

test("spreadMetres is the distance between the two furthest points", () => {
  const spread = spreadMetres([
    { latitude: 1.3, longitude: 103.85 },
    { latitude: 1.3, longitude: 103.86 },
    { latitude: 1.31, longitude: 103.85 },
  ]);
  assert.ok(spread > 1500 && spread < 1600, `got ${spread}`);
});

test("spreadMetres is 0 for one point or none", () => {
  assert.equal(spreadMetres([{ latitude: 1.3, longitude: 103.8 }]), 0);
  assert.equal(spreadMetres([]), 0);
});

// ---- search radius and candidate cap --------------------------------------

test("searchRadius is half the spread, between 1.5 km and 5 km", () => {
  assert.equal(searchRadius(0), 1500);
  assert.equal(searchRadius(1000), 1500);
  assert.equal(searchRadius(4000), 2000);
  assert.equal(searchRadius(20000), 5000);
  assert.equal(searchRadius(100000), 5000);
});

test("maxCandidates keeps origins x destinations within Google's 100-pair limit", () => {
  assert.equal(maxCandidates(1), 100);
  assert.equal(maxCandidates(4), 25);
  assert.equal(maxCandidates(3), 33);
  assert.equal(maxCandidates(10), 10);
  assert.equal(maxCandidates(0), 0);
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    assert.ok(n * maxCandidates(n) <= 100);
  }
});

// ---- estimate -------------------------------------------------------------

test("estimateMinutes adds a detour, a transit speed and a fixed wait", () => {
  // 5 km straight line: 6.5 km at 22 km/h is about 17.7 min, plus 5.
  assert.equal(estimateMinutes(5000), 23);
  assert.equal(estimateMinutes(0), 5);
});

// ---- matrix request and response ------------------------------------------

test("buildMatrixRequest asks for transit with lat/lng waypoints", () => {
  const body = buildMatrixRequest(
    [{ latitude: 1.3, longitude: 103.8, name: "ignored" }],
    [{ latitude: 1.4, longitude: 103.9 }],
  );
  assert.equal(body.travelMode, "TRANSIT");
  assert.deepEqual(body.origins, [
    { waypoint: { location: { latLng: { latitude: 1.3, longitude: 103.8 } } } },
  ]);
  assert.deepEqual(body.destinations, [
    { waypoint: { location: { latLng: { latitude: 1.4, longitude: 103.9 } } } },
  ]);
  assert.equal("departureTime" in body, false);
});

test("parseMatrix reads durations and treats missing indices as 0", () => {
  const parsed = parseMatrix([
    { duration: "600s", condition: "ROUTE_EXISTS" },
    { originIndex: 1, duration: "1500.4s", condition: "ROUTE_EXISTS" },
    { destinationIndex: 2, duration: "90s", condition: "ROUTE_EXISTS" },
  ]);
  assert.equal(parsed.get("0:0"), 10);
  assert.equal(parsed.get("1:0"), 25);
  assert.equal(parsed.get("0:2"), 2);
});

test("parseMatrix never returns less than a minute", () => {
  assert.equal(parseMatrix([{ duration: "10s", condition: "ROUTE_EXISTS" }]).get("0:0"), 1);
});

test("parseMatrix skips pairs with no usable route", () => {
  const parsed = parseMatrix([
    { condition: "ROUTE_NOT_FOUND" },
    { originIndex: 1, duration: "600s", condition: "ROUTE_EXISTS", status: { code: 5 } },
    { destinationIndex: 1, condition: "ROUTE_EXISTS" },
    { destinationIndex: 2, duration: "soon", condition: "ROUTE_EXISTS" },
  ]);
  assert.equal(parsed.size, 0);
});

test("parseMatrix returns an empty map for anything that is not an array", () => {
  assert.equal(parseMatrix({ error: { code: 403 } }).size, 0);
  assert.equal(parseMatrix(null).size, 0);
  assert.equal(parseMatrix(undefined).size, 0);
});

// ---- per-person times -----------------------------------------------------

const ORIGINS = [
  { name: "Aisha", latitude: 1.3, longitude: 103.85 },
  { name: "Wei Jie", latitude: 1.3, longitude: 103.7 },
];
const DEST = { latitude: 1.3, longitude: 103.85 };

test("timesToDestination uses the matrix where it has a pair", () => {
  const times = timesToDestination(ORIGINS, DEST, 0, new Map([["0:0", 12], ["1:0", 40]]));
  assert.deepEqual(times, [
    { name: "Aisha", minutes: 12, estimated: false },
    { name: "Wei Jie", minutes: 40, estimated: false },
  ]);
});

test("timesToDestination estimates only the pairs the matrix is missing", () => {
  const times = timesToDestination(ORIGINS, DEST, 0, new Map([["0:0", 12]]));
  assert.deepEqual(times[0], { name: "Aisha", minutes: 12, estimated: false });
  assert.equal(times[1].estimated, true);
  assert.equal(
    times[1].minutes,
    estimateMinutes(haversineMetres(ORIGINS[1], DEST)),
  );
});

test("timesToDestination looks pairs up by destination index", () => {
  const parsed = new Map([["0:1", 7]]);
  const times = timesToDestination([ORIGINS[0]], DEST, 1, parsed);
  assert.equal(times[0].minutes, 7);
});

test("summariseTimes finds the longest trip, the total, and flags long trips", () => {
  const summary = summariseTimes([
    { name: "A", minutes: 20, estimated: false },
    { name: "B", minutes: 61, estimated: false },
    { name: "C", minutes: 30, estimated: false },
  ]);
  assert.deepEqual(summary, {
    longest: { name: "B", minutes: 61 },
    total_min: 111,
    long_trip: true,
  });
});

test("an hour exactly is not a long trip", () => {
  assert.equal(summariseTimes([{ name: "A", minutes: 60, estimated: false }]).long_trip, false);
});

// ---- ranking --------------------------------------------------------------

const cand = (name, longest, total) => ({
  name,
  longest: { name: "x", minutes: longest },
  total_min: total,
});

test("rankCandidates puts the shortest longest trip first", () => {
  const ranked = rankCandidates([cand("Far", 50, 90), cand("Near", 30, 80), cand("Mid", 40, 70)]);
  assert.deepEqual(ranked.map((c) => c.name), ["Near", "Mid", "Far"]);
});

test("rankCandidates breaks ties by total time, then name", () => {
  const ranked = rankCandidates([cand("B", 30, 90), cand("A", 30, 90), cand("C", 30, 80)]);
  assert.deepEqual(ranked.map((c) => c.name), ["C", "A", "B"]);
});

test("rankCandidates does not change the array it was given", () => {
  const input = [cand("B", 50, 1), cand("A", 10, 1)];
  rankCandidates(input);
  assert.deepEqual(input.map((c) => c.name), ["B", "A"]);
});
