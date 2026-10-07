import { test } from "node:test";
import assert from "node:assert/strict";
import { validateMember } from "../src/validate.js";

const valid = {
  name: "Mei",
  area: "Paya Lebar",
  cuisines: ["Japanese", "korean"],
  dietary: ["vegetarian"],
  notes: "no spicy",
};

test("accepts a valid member and normalises cuisines", () => {
  const { value, error } = validateMember(valid);
  assert.equal(error, undefined);
  assert.deepEqual(value.cuisines, ["japanese", "korean"]);
  assert.deepEqual(value.dietary, ["vegetarian"]);
});

test("trims strings and removes duplicates", () => {
  const { value } = validateMember({
    ...valid,
    name: "  Mei  ",
    cuisines: ["korean", " Korean "],
    dietary: ["halal", "halal"],
  });
  assert.equal(value.name, "Mei");
  assert.deepEqual(value.cuisines, ["korean"]);
  assert.deepEqual(value.dietary, ["halal"]);
});

test("defaults cuisines, dietary and notes when omitted", () => {
  const { value } = validateMember({ name: "Raj", area: "Bishan" });
  assert.deepEqual(value, { name: "Raj", area: "Bishan", notes: "", cuisines: [], dietary: [] });
});

test("rejects non-object bodies", () => {
  assert.match(validateMember(null).error, /JSON object/);
  assert.match(validateMember("hi").error, /JSON object/);
});

test("requires a name and an area", () => {
  assert.match(validateMember({ ...valid, name: "  " }).error, /name/);
  assert.match(validateMember({ ...valid, area: "" }).error, /area/);
  assert.match(validateMember({ ...valid, name: 5 }).error, /name/);
});

test("rejects over-long fields", () => {
  assert.match(validateMember({ ...valid, name: "x".repeat(31) }).error, /name/);
  assert.match(validateMember({ ...valid, area: "x".repeat(61) }).error, /area/);
  assert.match(validateMember({ ...valid, notes: "x".repeat(201) }).error, /notes/);
});

test("rejects unknown dietary values", () => {
  assert.match(validateMember({ ...valid, dietary: ["keto"] }).error, /dietary/);
  assert.match(validateMember({ ...valid, dietary: "halal" }).error, /dietary/);
});

test("rejects too many or malformed cuisines", () => {
  const seven = ["a", "b", "c", "d", "e", "f", "g"];
  assert.match(validateMember({ ...valid, cuisines: seven }).error, /cuisines/);
  assert.match(validateMember({ ...valid, cuisines: [""] }).error, /cuisines/);
  assert.match(validateMember({ ...valid, cuisines: [3] }).error, /cuisines/);
  assert.match(validateMember({ ...valid, cuisines: "korean" }).error, /cuisines/);
});
