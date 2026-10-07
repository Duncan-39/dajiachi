import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSystemPrompt } from "../src/prompt.js";

test("the prompt makes dietary rules hard and forbids halal and allergy claims", () => {
  const prompt = buildSystemPrompt();
  assert.match(prompt, /hard rules/);
  assert.match(prompt, /Never say a place is halal-certified, vegan, or safe for an allergy/);
  assert.match(prompt, /MUIS/);
  assert.match(prompt, /nut_allergy and no_shellfish/);
});

test("the prompt says to relax likes before dietary rules and never to pad the shortlist", () => {
  const prompt = buildSystemPrompt();
  assert.match(prompt, /Cuisine likes are soft/);
  assert.match(prompt, /Never add a place just to make three/);
});

test("the prompt tells the model to flag estimates, long trips and unlocated members", () => {
  const prompt = buildSystemPrompt();
  assert.match(prompt, /estimated true, say it is an estimate/);
  assert.match(prompt, /long_trip true/);
  assert.match(prompt, /central MRT hub/);
  assert.match(prompt, /unlocated/);
});

test("the prompt asks for a spoken verdict in full sentences, for every tone", () => {
  for (const tone of ["singlish", "professional", "uncle"]) {
    const prompt = buildSystemPrompt(tone);
    assert.match(prompt, /the way you would say it out loud to the group/);
    assert.match(prompt, /three to five full sentences/);
    assert.match(prompt, /No bullet points, no lists, no sentence fragments/);
    // The old wording asked for a terse note, which came out as point form.
    assert.doesNotMatch(prompt, /under 80 words/);
  }
});

test("the prompt says notes it cannot check must be named, not pretended", () => {
  const prompt = buildSystemPrompt();
  assert.match(prompt, /air-con/);
  assert.match(prompt, /delivery/);
  assert.match(prompt, /say which notes you could not act on/);
  assert.match(prompt, /two notes clash/);
});

test("the prompt names the tools in the order to use them", () => {
  const prompt = buildSystemPrompt();
  const order = ["read_votes", "find_candidates", "write_shortlist"].map((name) =>
    prompt.indexOf(name),
  );
  assert.ok(order.every((i) => i >= 0));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

test("the prompt does not force a separate locate_members round", () => {
  const prompt = buildSystemPrompt();
  assert.match(prompt, /find_candidates for the most-voted cuisines/);
  assert.match(prompt, /Call locate_members only if you need/);
});

test("each prompt is unique to the request", () => {
  assert.notEqual(buildSystemPrompt(), buildSystemPrompt());
});

// ---- tones ----------------------------------------------------------------

import { TONES, DEFAULT_TONE, RULES, isTone } from "../src/prompt.js";

test("the default tone is the Singlish referee", () => {
  assert.equal(DEFAULT_TONE, "singlish");
  assert.match(buildSystemPrompt(), /I settle this one, no more arguing/);
});

test("there are exactly the three tones the page offers", () => {
  assert.deepEqual(Object.keys(TONES), ["singlish", "professional", "uncle"]);
  for (const tone of Object.values(TONES)) {
    assert.ok(tone.label.length > 0);
    assert.match(tone.voice, /^How you talk:/);
  }
});

test("every tone gets the identical rules, so none can relax a dietary rule", () => {
  for (const tone of Object.keys(TONES)) {
    const prompt = buildSystemPrompt(tone);
    assert.ok(prompt.endsWith(RULES), `${tone} does not end with the shared rules`);
    assert.match(prompt, /Dietary constraints are hard rules/);
    assert.match(prompt, /Never say a place is halal-certified, vegan, or safe for an allergy/);
    assert.match(prompt, /MUIS/);
  }
});

test("the tones sound different from each other", () => {
  const singlish = buildSystemPrompt("singlish");
  const professional = buildSystemPrompt("professional");
  const uncle = buildSystemPrompt("uncle");

  assert.match(professional, /No slang, no jokes/);
  assert.doesNotMatch(professional, /lah/);
  assert.doesNotMatch(professional, /I settle this one/);
  assert.match(uncle, /A bit impatient/);
  assert.match(uncle, /strong opinions/);
  assert.doesNotMatch(singlish, /impatient/);
  assert.doesNotMatch(uncle, /No slang/);
});

test("the voice never repeats rules and the rules never contain a voice", () => {
  for (const tone of Object.values(TONES)) {
    assert.doesNotMatch(tone.voice, /hard rules|write_shortlist|MUIS/);
  }
  assert.doesNotMatch(RULES, /How you talk/);
});

test("an unknown tone is refused rather than silently replaced", () => {
  assert.throws(() => buildSystemPrompt("pirate"), /Unknown tone: pirate/);
  assert.throws(() => buildSystemPrompt("constructor"), /Unknown tone/);
  assert.throws(() => buildSystemPrompt("__proto__"), /Unknown tone/);
});

test("isTone accepts only the tone names", () => {
  assert.equal(isTone("uncle"), true);
  for (const bad of ["Uncle", "", "toString", "hasOwnProperty", "__proto__", null, undefined, 5, {}, ["uncle"]]) {
    assert.equal(isTone(bad), false, `accepted ${String(bad)}`);
  }
});
