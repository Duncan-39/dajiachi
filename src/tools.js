/**
 * Tool definitions and implementations for Da Jia Chi.
 *
 * Each tool is split in two: a function that does IO (D1 or the network) and
 * pure functions that shape or rank the result. The pure functions are the
 * ones covered by tests.
 *
 * The model never supplies coordinates or travel times. Locations come from
 * D1 and Google, times come from the Routes API (or a labelled estimate), and
 * write_shortlist only accepts places that find_candidates returned.
 */

import { listMembers, listShortlists } from "./db.js";
import {
  haversineMetres,
  midpoint,
  spreadMetres,
  searchRadius,
  maxCandidates,
  buildMatrixRequest,
  parseMatrix,
  timesToDestination,
  summariseTimes,
  rankCandidates,
} from "./travel.js";

const MAX_PLACES = 20;
const MAX_PICKS = 3;
// The code ranks every candidate, so the model only needs the fairest few to
// choose from. A shorter tool result keeps the next model call fast.
const MAX_RETURNED = 8;

const PLACES_URL = "https://places.googleapis.com/v1/places:searchText";
const ROUTES_URL =
  "https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix";
const FORECAST_URL =
  "https://api-open.data.gov.sg/v2/real-time/api/two-hr-forecast";

const MAX_REASON_LENGTH = 300;
const MAX_SUMMARY_LENGTH = 700;

// Cuisines that clash with a dietary constraint. Halal is not listed: a halal
// member can still eat most of these at a halal-friendly place.
const BLOCKED_CUISINES = {
  vegan: ["steakhouse", "seafood", "bbq"],
  vegetarian: ["steakhouse", "seafood", "bbq"],
  no_beef: ["steakhouse"],
  no_shellfish: ["seafood"],
};

// ---------------------------------------------------------------------------
// Definitions sent to the model
// ---------------------------------------------------------------------------

export const toolDefinitions = [
  {
    type: "function",
    function: {
      name: "read_votes",
      description:
        "Read everyone in the poll: area, cuisine likes, dietary constraints, notes, a cuisine vote tally, a dietary summary with clash warnings, and earlier shortlists. Call this first.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "locate_members",
      description:
        "Find where each member is coming from and work out a meeting point and how spread out the group is. Lists members whose area could not be found.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "find_candidates",
      description:
        "Search for restaurants near the group's meeting point and get each one's travel time for every member. Results are sorted fairest first: shortest longest trip. Each result has an id to use in write_shortlist.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              'What to search for, e.g. "indian", "thai or zi char". Dietary keywords such as halal are added for you.',
          },
          open_now: {
            type: "boolean",
            description: "Only return places open right now. Defaults to true.",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_rain_forecast",
      description:
        "Get the two-hour weather forecast for a Singapore area, e.g. the area around a candidate.",
      parameters: {
        type: "object",
        properties: {
          area: {
            type: "string",
            description: 'Singapore forecast area name, e.g. "Bishan" or "Kallang".',
          },
        },
        required: ["area"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_shortlist",
      description:
        "Save the shortlist (one to three places, best first) so everyone sees it. Call this once, with all your picks together, using ids from find_candidates.",
      parameters: {
        type: "object",
        properties: {
          picks: {
            type: "array",
            minItems: 1,
            maxItems: MAX_PICKS,
            items: {
              type: "object",
              properties: {
                id: { type: "string", description: "A candidate id from find_candidates." },
                reason: {
                  type: "string",
                  description: "One or two sentences on why this place, using only facts from the tool results.",
                },
              },
              required: ["id", "reason"],
            },
          },
          summary: {
            type: "string",
            description:
              "The verdict everyone reads, under 80 words: why this order, what you relaxed, who lost out, and what needs confirming.",
          },
        },
        required: ["picks", "summary"],
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * State shared by every tool call in one run.
 */
export function createToolState() {
  return {
    members: null,
    origins: null, // located members: { name, area, latitude, longitude }
    unlocated: [],
    midpoint: null,
    spread: 0,
    candidates: new Map(), // id -> candidate, as returned by find_candidates
    nextCandidate: 1,
    shortlist: null, // set by write_shortlist, stored by the caller after the run
  };
}

/**
 * Run one tool call requested by the model and return the result as a string.
 *
 * ctx is { env, room, state }. Tools that find or rank places only read; the
 * one result that gets stored (state.shortlist) is saved by the caller.
 */
export async function executeTool(name, args, ctx) {
  switch (name) {
    case "read_votes":
      return JSON.stringify(await readVotes(ctx));
    case "locate_members":
      return JSON.stringify(await locateMembers(ctx));
    case "find_candidates":
      return JSON.stringify(await findCandidates(args, ctx));
    case "get_rain_forecast":
      return JSON.stringify(await getRainForecast(args));
    case "write_shortlist":
      return JSON.stringify(writeShortlist(args, ctx));
    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

async function ensureMembers({ env, room, state }) {
  state.members ??= await listMembers(env.DB, room);
  return state.members;
}

// ---------------------------------------------------------------------------
// read_votes
// ---------------------------------------------------------------------------

async function readVotes(ctx) {
  const members = await ensureMembers(ctx);
  const shortlists = await listShortlists(ctx.env.DB, ctx.room);
  return {
    ...formatMembers(members, shortlists),
    dietary_summary: checkDietaryConflicts(members),
  };
}

/**
 * Shape members and past shortlists for the model, with a cuisine tally.
 */
export function formatMembers(members, shortlists = []) {
  const tally = new Map();
  for (const m of members) {
    for (const cuisine of m.cuisines) {
      const voters = tally.get(cuisine) ?? [];
      voters.push(m.name);
      tally.set(cuisine, voters);
    }
  }

  return {
    members: members.map(({ name, area, cuisines, dietary, notes }) => ({
      name,
      area,
      cuisines,
      dietary,
      notes,
    })),
    cuisine_votes: [...tally.entries()]
      .map(([cuisine, voters]) => ({ cuisine, votes: voters.length, voters }))
      .sort((a, b) => b.votes - a.votes || a.cuisine.localeCompare(b.cuisine)),
    previous_shortlists: shortlists.slice(0, 3).map((s) => ({
      places: s.picks.map((p) => p.name),
      summary: s.summary,
    })),
  };
}

// ---------------------------------------------------------------------------
// Dietary summary
// ---------------------------------------------------------------------------

/**
 * Merge dietary constraints into hard rules and flag clashes. Pure.
 */
export function checkDietaryConflicts(members) {
  const holders = {};
  for (const m of members) {
    for (const rule of m.dietary) {
      (holders[rule] ??= []).push(m.name);
    }
  }

  // Vegan implies vegetarian, so one keyword is enough.
  const searchKeywords = [];
  if (holders.halal) searchKeywords.push("halal");
  if (holders.vegan) searchKeywords.push("vegan");
  else if (holders.vegetarian) searchKeywords.push("vegetarian");

  // These cannot be searched for, so the referee has to flag them.
  const avoid = [];
  if (holders.no_beef) avoid.push("beef");
  if (holders.no_shellfish) avoid.push("shellfish");
  if (holders.nut_allergy) avoid.push("nuts");

  const warnings = [];
  for (const m of members) {
    if (m.cuisines.length === 0) continue;
    const clashes = [];
    for (const [rule, names] of Object.entries(holders)) {
      const blocked = BLOCKED_CUISINES[rule] ?? [];
      const others = names.filter((n) => n !== m.name);
      if (others.length > 0 && m.cuisines.every((c) => blocked.includes(c))) {
        clashes.push(`${others.join(", ")} (${rule})`);
      }
    }
    if (clashes.length > 0) {
      warnings.push(
        `${m.name} only picked ${m.cuisines.join(", ")}, which clashes with ${clashes.join("; ")}.`,
      );
    }
  }

  return { hard_constraints: holders, search_keywords: searchKeywords, avoid, warnings };
}

// ---------------------------------------------------------------------------
// locate_members
// ---------------------------------------------------------------------------

async function locateMembers(ctx) {
  const located = await ensureLocated(ctx);
  if (located.error) return located;
  const { state } = ctx;
  return {
    midpoint: state.midpoint,
    spread_m: state.spread,
    located: state.origins.map((o) => ({ name: o.name, area: o.area })),
    unlocated: state.unlocated,
  };
}

/**
 * Geocode every member's area once per run and cache the result in state.
 */
async function ensureLocated(ctx) {
  const { env, state } = ctx;
  if (state.origins) return { ok: true };

  const members = await ensureMembers(ctx);
  if (members.length === 0) {
    return { error: "Nobody has joined this poll yet" };
  }

  // Members who typed the same area share one lookup.
  const areas = [...new Set(members.map((m) => m.area.toLowerCase()))];
  const found = new Map(
    await Promise.all(areas.map(async (area) => [area, await geocodeArea(area, env)])),
  );

  const origins = [];
  const unlocated = [];
  for (const m of members) {
    const point = found.get(m.area.toLowerCase());
    if (point) origins.push({ name: m.name, area: m.area, ...point });
    else unlocated.push(m.name);
  }

  if (origins.length === 0) {
    return { error: "Could not locate any member's area", unlocated };
  }

  state.origins = origins;
  state.unlocated = unlocated;
  state.midpoint = midpoint(origins);
  state.spread = spreadMetres(origins);
  return { ok: true };
}

async function geocodeArea(area, env) {
  const res = await fetch(PLACES_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Goog-Api-Key": env.GOOGLE_PLACES_API_KEY,
      "X-Goog-FieldMask": "places.location",
    },
    body: JSON.stringify({
      textQuery: `${area}, Singapore`,
      regionCode: "SG",
      pageSize: 1,
    }),
  });
  if (!res.ok) return null;
  return formatGeocode(await res.json());
}

/**
 * Pull the first result's coordinates out of a Places text search response.
 */
export function formatGeocode(payload) {
  const location = payload?.places?.[0]?.location;
  if (
    !location ||
    typeof location.latitude !== "number" ||
    typeof location.longitude !== "number"
  ) {
    return null;
  }
  return { latitude: location.latitude, longitude: location.longitude };
}

// ---------------------------------------------------------------------------
// find_candidates
// ---------------------------------------------------------------------------

async function findCandidates({ query, open_now = true }, ctx) {
  if (typeof query !== "string" || query.trim() === "") {
    return { error: "query is required" };
  }

  const members = await ensureMembers(ctx);
  const located = await ensureLocated(ctx);
  if (located.error) return located;
  const { env, state } = ctx;

  const dietary = checkDietaryConflicts(members);
  const radius = searchRadius(state.spread);

  const res = await fetch(PLACES_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Goog-Api-Key": env.GOOGLE_PLACES_API_KEY,
      "X-Goog-FieldMask":
        "places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.priceLevel,places.currentOpeningHours,places.servesVegetarianFood",
    },
    body: JSON.stringify({
      textQuery: withKeywords(query, dietary.search_keywords),
      includedType: "restaurant",
      openNow: open_now,
      pageSize: MAX_PLACES,
      locationBias: { circle: { center: state.midpoint, radius } },
    }),
  });
  if (!res.ok) {
    return { error: `Places API returned ${res.status}` };
  }

  const data = await res.json();
  const places = selectPlaces(
    formatPlaces(data.places ?? [], state.midpoint),
    dietary.hard_constraints,
    maxCandidates(state.origins.length),
  );

  const parsed = await fetchTravelMatrix(state.origins, places, env);
  const ranked = rankCandidates(
    buildCandidates(places, state.origins, parsed, dietary.hard_constraints),
  );

  const candidates = ranked.slice(0, MAX_RETURNED).map((c) => {
    const id = `p${state.nextCandidate++}`;
    state.candidates.set(id, { id, ...c });
    return toModelCandidate({ id, ...c });
  });

  return {
    candidates,
    search_radius_m: radius,
    group_spread_m: state.spread,
    unlocated: state.unlocated,
    ...(candidates.length === 0 && {
      note: "No places matched. Try a broader query or open_now false.",
    }),
  };
}

/**
 * Add dietary search keywords to a query without repeating words already in it.
 */
export function withKeywords(query, keywords) {
  const lower = query.toLowerCase();
  const extra = keywords.filter((k) => !lower.includes(k));
  return [query.trim(), ...extra].join(" ");
}

async function fetchTravelMatrix(origins, places, env) {
  if (places.length === 0) return new Map();
  try {
    const res = await fetch(ROUTES_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Goog-Api-Key": env.GOOGLE_PLACES_API_KEY,
        "X-Goog-FieldMask": "originIndex,destinationIndex,duration,condition,status",
      },
      body: JSON.stringify(buildMatrixRequest(origins, places.map((p) => p.location))),
    });
    // A disabled Routes API (403) or any other failure means every pair falls
    // back to a labelled estimate.
    if (!res.ok) return new Map();
    return parseMatrix(await res.json());
  } catch {
    return new Map();
  }
}

/**
 * Shape Places results into the fields the referee needs.
 */
export function formatPlaces(places, origin) {
  return places.map((p) => ({
    name: p.displayName?.text ?? "Unnamed",
    address: p.formattedAddress ?? null,
    rating: p.rating ?? null,
    price_level: p.priceLevel ?? null,
    open_now: p.currentOpeningHours?.openNow ?? null,
    serves_vegetarian_food: p.servesVegetarianFood ?? null,
    location: p.location ?? null,
    distance_m: p.location ? Math.round(haversineMetres(origin, p.location)) : null,
  }));
}

/**
 * Drop places that cannot be used, then keep the closest to the midpoint so
 * the travel matrix stays inside Google's pair limit.
 *
 * Vegetarian is the only dietary need Google reports. A place that says it
 * does not serve vegetarian food is dropped when anyone is vegetarian or
 * vegan. Everything else is flagged later, never filtered.
 */
export function selectPlaces(places, holders, limit) {
  const needsVegetarian = Boolean(holders.vegetarian || holders.vegan);
  return places
    .filter((p) => p.location !== null)
    .filter((p) => !(needsVegetarian && p.serves_vegetarian_food === false))
    .sort((a, b) => a.distance_m - b.distance_m)
    .slice(0, limit);
}

/**
 * Attach travel times and unverified dietary needs to each place. Pure.
 */
export function buildCandidates(places, origins, parsed, holders) {
  return places.map((place, destinationIndex) => {
    const times = timesToDestination(origins, place.location, destinationIndex, parsed);
    const { location: _location, distance_m: _distance, ...rest } = place;
    return {
      ...rest,
      times,
      ...summariseTimes(times),
      unverified_needs: unverifiedNeeds(holders, place),
    };
  });
}

/**
 * Dietary needs that nothing in the search results can confirm for a place.
 * Vegetarian is confirmed only when Google says the place serves it.
 */
export function unverifiedNeeds(holders, place) {
  const needs = Object.keys(holders).filter((rule) => rule !== "vegetarian");
  if (holders.vegetarian && place.serves_vegetarian_food !== true) {
    needs.push("vegetarian");
  }
  return needs.sort();
}

function toModelCandidate(c) {
  return {
    id: c.id,
    name: c.name,
    address: c.address,
    rating: c.rating,
    price_level: c.price_level,
    open_now: c.open_now,
    serves_vegetarian_food: c.serves_vegetarian_food,
    times: c.times,
    longest: c.longest,
    total_min: c.total_min,
    long_trip: c.long_trip,
    unverified_needs: c.unverified_needs,
  };
}

// ---------------------------------------------------------------------------
// get_rain_forecast
// ---------------------------------------------------------------------------

async function getRainForecast({ area }) {
  if (typeof area !== "string" || area.trim() === "") {
    return { error: "area is required" };
  }
  const res = await fetch(FORECAST_URL);
  if (!res.ok) {
    return { error: `Forecast API returned ${res.status}` };
  }
  return formatForecast(await res.json(), area.trim());
}

/**
 * Pull one area's forecast out of the data.gov.sg two-hour forecast payload.
 * The area match ignores case.
 */
export function formatForecast(payload, area) {
  const item = payload?.data?.items?.[0];
  if (!item) {
    return { error: "No forecast available" };
  }
  const entry = item.forecasts.find(
    (f) => f.area.toLowerCase() === area.toLowerCase(),
  );
  return {
    area,
    forecast: entry?.forecast ?? "Unknown",
    valid_period: item.valid_period?.text ?? null,
  };
}

// ---------------------------------------------------------------------------
// write_shortlist
// ---------------------------------------------------------------------------

function writeShortlist({ picks, summary }, ctx) {
  const built = buildShortlist(picks, summary, ctx.state.candidates);
  if (built.error) {
    return { error: built.error };
  }
  // Held until the run ends rather than written now, so a second call
  // replaces the first and each run stores exactly one shortlist.
  ctx.state.shortlist = {
    summary: built.summary,
    picks: built.picks,
    unlocated: ctx.state.unlocated,
  };
  return { saved: true, places: built.picks.map((p) => p.name) };
}

/**
 * Check the model's picks against this run's candidates and build what gets
 * stored. Names, times and flags always come from the candidate, never from
 * the model. Pure.
 */
export function buildShortlist(picks, summary, candidates) {
  if (!Array.isArray(picks) || picks.length === 0 || picks.length > MAX_PICKS) {
    return { error: `picks must contain 1 to ${MAX_PICKS} places` };
  }
  if (typeof summary !== "string" || summary.trim() === "") {
    return { error: "summary is required" };
  }

  const seen = new Set();
  const stored = [];
  for (const pick of picks) {
    const id = pick?.id;
    const candidate = candidates.get(id);
    if (!candidate) {
      return { error: `Unknown candidate id: ${id}. Use ids from find_candidates.` };
    }
    if (seen.has(id)) {
      return { error: `Duplicate candidate id: ${id}` };
    }
    if (typeof pick.reason !== "string" || pick.reason.trim() === "") {
      return { error: `reason is required for ${id}` };
    }
    seen.add(id);
    stored.push({
      rank: stored.length + 1,
      name: candidate.name,
      address: candidate.address,
      rating: candidate.rating,
      price_level: candidate.price_level,
      open_now: candidate.open_now,
      serves_vegetarian_food: candidate.serves_vegetarian_food,
      times: candidate.times,
      longest: candidate.longest,
      long_trip: candidate.long_trip,
      unverified_needs: candidate.unverified_needs,
      reason: pick.reason.trim().slice(0, MAX_REASON_LENGTH),
    });
  }

  return { picks: stored, summary: summary.trim().slice(0, MAX_SUMMARY_LENGTH) };
}
