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
