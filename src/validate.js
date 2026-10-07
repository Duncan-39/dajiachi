/**
 * Input validation for member submissions. Pure, so it is easy to test.
 */

// Hard constraints. The model may never drop these.
export const DIETARY = [
  "halal",
  "vegetarian",
  "vegan",
  "no_beef",
  "no_shellfish",
  "nut_allergy",
];

const MAX_NAME = 30;
const MAX_AREA = 60;
const MAX_NOTES = 200;
const MAX_CUISINES = 6;
const MAX_CUISINE_LENGTH = 30;

/**
 * Check a raw member payload. Returns { value } on success or { error }.
 */
export function validateMember(input) {
  if (!input || typeof input !== "object") {
    return { error: "Body must be a JSON object" };
  }

  const name = cleanString(input.name);
  if (name === "" || name.length > MAX_NAME) {
    return { error: `name is required (max ${MAX_NAME} characters)` };
  }

  const area = cleanString(input.area);
  if (area === "" || area.length > MAX_AREA) {
    return { error: `area is required (max ${MAX_AREA} characters)` };
  }

  const notes = cleanString(input.notes ?? "");
  if (notes.length > MAX_NOTES) {
    return { error: `notes must be at most ${MAX_NOTES} characters` };
  }

  const cuisines = input.cuisines ?? [];
  if (
    !Array.isArray(cuisines) ||
    cuisines.length > MAX_CUISINES ||
    cuisines.some((c) => typeof c !== "string" || c.trim() === "" || c.length > MAX_CUISINE_LENGTH)
  ) {
    return { error: `cuisines must be up to ${MAX_CUISINES} short strings` };
  }

  const dietary = input.dietary ?? [];
  if (!Array.isArray(dietary) || dietary.some((d) => !DIETARY.includes(d))) {
    return { error: `dietary must only contain: ${DIETARY.join(", ")}` };
  }

  return {
    value: {
      name,
      area,
      notes,
      cuisines: [...new Set(cuisines.map((c) => c.trim().toLowerCase()))],
      dietary: [...new Set(dietary)],
    },
  };
}

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}
