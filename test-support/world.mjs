// A fake outside world for tests: Google Places, the Routes API, the weather
// forecast and the LLM. Pass the result to stubFetch().
//
// Areas the geocoder knows about, with a place list laid out so the order
// is predictable. Midpoint of Pasir Ris and Boon Lay is about 1.3555, 103.8275.
import { jsonResponse } from "./fetch-stub.mjs";

export const AREA_POINTS = {
  "boon lay": { latitude: 1.338, longitude: 103.706 },
  "pasir ris": { latitude: 1.373, longitude: 103.949 },
  bishan: { latitude: 1.351, longitude: 103.848 },
};

// Listed in the order Google returns them. Distance from the midpoint is
// Alpha < Bravo < Dud < Charlie. Dud says it has no vegetarian food.
export const PLACE_LIST = [
  place("Charlie", 1.37, 103.8275, { servesVegetarianFood: true }),
  place("Dud", 1.365, 103.8275, { servesVegetarianFood: false }),
  place("Alpha", 1.3555, 103.8275, { servesVegetarianFood: true }),
  place("Bravo", 1.36, 103.8275, {}),
];

// Transit seconds per place for [first origin, second origin].
export const SECONDS = {
  Alpha: [2400, 2700],
  Bravo: [1800, 3000],
  Charlie: [2100, 2160],
  Dud: [1000, 1000],
};

function place(name, latitude, longitude, extra) {
  return {
    id: `id-${name}`,
    displayName: { text: name },
    formattedAddress: `1 ${name} Road`,
    location: { latitude, longitude },
    rating: 4.2,
    priceLevel: "PRICE_LEVEL_MODERATE",
    currentOpeningHours: { openNow: true },
    ...extra,
  };
}

/**
 * Build a stubFetch handler. llm(call, n) answers the nth LLM call.
 * options.routes: "ok" (default) or "forbidden" (Routes API disabled).
 */
export function world(llm, { routes = "ok", places = PLACE_LIST } = {}) {
  let llmCalls = 0;
  return (call) => {
    if (call.url.endsWith("/chat/completions")) {
      llmCalls += 1;
      return llm(call, llmCalls);
    }
    if (call.url.includes("routes.googleapis.com")) {
      return routes === "forbidden"
        ? jsonResponse({ error: { code: 403, status: "PERMISSION_DENIED" } }, 403)
        : jsonResponse(matrixFor(call.body, places));
    }
    if (call.url.includes("places.googleapis.com")) {
      const { textQuery, pageSize } = call.body;
      if (pageSize === 1 && textQuery.endsWith(", Singapore")) {
        const area = textQuery.replace(", Singapore", "").toLowerCase();
        const point = AREA_POINTS[area];
        return jsonResponse(point ? { places: [{ location: point }] } : {});
      }
      return jsonResponse({ places });
    }
    if (call.url.includes("data.gov.sg")) {
      return jsonResponse({
        data: {
          items: [
            {
              valid_period: { text: "1 pm to 3 pm" },
              forecasts: [{ area: "Bishan", forecast: "Cloudy" }],
            },
          ],
        },
      });
    }
    throw new Error(`world: unexpected fetch to ${call.url}`);
  };
}

// Build a computeRouteMatrix response for whatever destinations were asked
// for. Proto3 JSON leaves out zero indices, so this does too.
function matrixFor(body, places) {
  const elements = [];
  body.destinations.forEach((dest, d) => {
    const { latitude } = dest.waypoint.location.latLng;
    const index = places.findIndex((p) => p.location.latitude === latitude);
    const name = places[index].displayName.text;
    // Places not in the table get a time that grows with their list position.
    const seconds = SECONDS[name] ?? [1200 + index * 60, 1200 + index * 60];
    body.origins.forEach((_, o) => {
      const el = { duration: `${seconds[o]}s`, condition: "ROUTE_EXISTS" };
      if (o !== 0) el.originIndex = o;
      if (d !== 0) el.destinationIndex = d;
      elements.push(el);
    });
  });
  return elements;
}
