/**
 * Geometry, travel-time and ranking helpers. All pure, so they are easy to
 * test. The one network call (the Routes API matrix) lives in tools.js.
 */

// Google allows at most 100 origin x destination pairs per transit request.
export const TRANSIT_ELEMENT_LIMIT = 100;
export const LONG_TRIP_MINUTES = 60;

const MIN_RADIUS_METRES = 1500;
const MAX_RADIUS_METRES = 5000;

// Fallback estimate when Google has no route for a pair.
const DETOUR_FACTOR = 1.3;
const TRANSIT_SPEED_KMH = 22;
const FIXED_MINUTES = 5;

/**
 * Great-circle distance between two {latitude, longitude} points, in metres.
 */
export function haversineMetres(a, b) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Average of {latitude, longitude} points. A plain mean is accurate enough
 * across an island this size.
 */
export function midpoint(points) {
  const sum = points.reduce(
    (acc, p) => ({
      latitude: acc.latitude + p.latitude,
      longitude: acc.longitude + p.longitude,
    }),
    { latitude: 0, longitude: 0 },
  );
  return {
    latitude: round(sum.latitude / points.length, 5),
    longitude: round(sum.longitude / points.length, 5),
  };
}

/**
 * Distance in metres between the two furthest-apart points.
 */
export function spreadMetres(points) {
  let widest = 0;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      widest = Math.max(widest, haversineMetres(points[i], points[j]));
    }
  }
  return Math.round(widest);
}

/**
 * Search radius for a group: half the spread, kept between 1.5 km and 5 km.
 */
export function searchRadius(spread) {
  return Math.min(MAX_RADIUS_METRES, Math.max(MIN_RADIUS_METRES, Math.round(spread / 2)));
}

/**
 * How many candidate places fit in one transit matrix for this many people.
 */
export function maxCandidates(originCount) {
  return originCount > 0 ? Math.floor(TRANSIT_ELEMENT_LIMIT / originCount) : 0;
}

/**
 * Straight-line travel time estimate, in whole minutes.
 */
export function estimateMinutes(distanceMetres) {
  const hours = (distanceMetres * DETOUR_FACTOR) / 1000 / TRANSIT_SPEED_KMH;
  return Math.round(hours * 60 + FIXED_MINUTES);
}

/**
 * Body for a Routes API computeRouteMatrix request. Departure time is left
 * out, which means "now".
 */
export function buildMatrixRequest(origins, destinations) {
  const waypoint = (p) => ({
    waypoint: { location: { latLng: { latitude: p.latitude, longitude: p.longitude } } },
  });
  return {
    origins: origins.map(waypoint),
    destinations: destinations.map(waypoint),
    travelMode: "TRANSIT",
  };
}

/**
 * Turn a computeRouteMatrix response into a Map of "origin:destination" to
 * minutes. Pairs with no usable route are left out, so the caller falls back
 * to an estimate for them.
 */
export function parseMatrix(payload) {
  const minutes = new Map();
  if (!Array.isArray(payload)) return minutes;

  for (const el of payload) {
    // Proto3 JSON leaves out zero values, so a missing index means 0.
    const o = el.originIndex ?? 0;
    const d = el.destinationIndex ?? 0;
    if (el.condition !== "ROUTE_EXISTS" || el.status?.code) continue;
    const match = /^(\d+(?:\.\d+)?)s$/.exec(el.duration ?? "");
    if (!match) continue;
    minutes.set(`${o}:${d}`, Math.max(1, Math.round(Number(match[1]) / 60)));
  }
  return minutes;
}

/**
 * Per-person travel times to one destination. origins are named points;
 * parsed is the result of parseMatrix. Missing pairs use the estimate.
 */
export function timesToDestination(origins, destination, destinationIndex, parsed) {
  return origins.map((origin, i) => {
    const known = parsed.get(`${i}:${destinationIndex}`);
    if (known !== undefined) {
      return { name: origin.name, minutes: known, estimated: false };
    }
    return {
      name: origin.name,
      minutes: estimateMinutes(haversineMetres(origin, destination)),
      estimated: true,
    };
  });
}

/**
 * Summarise one place's times: longest trip (and whose it is) and the total.
 */
export function summariseTimes(times) {
  const longest = times.reduce((a, b) => (b.minutes > a.minutes ? b : a));
  return {
    longest: { name: longest.name, minutes: longest.minutes },
    total_min: times.reduce((sum, t) => sum + t.minutes, 0),
    long_trip: longest.minutes > LONG_TRIP_MINUTES,
  };
}

/**
 * Sort candidates fairest first: shortest longest trip, then shortest total,
 * then name so the order is stable.
 */
export function rankCandidates(candidates) {
  return [...candidates].sort(
    (a, b) =>
      a.longest.minutes - b.longest.minutes ||
      a.total_min - b.total_min ||
      a.name.localeCompare(b.name),
  );
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
