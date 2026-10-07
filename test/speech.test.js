import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The speech helpers live inside the page's own script, because the page has
// no build step and cannot import. Pull out that block and run it on its own.
const html = readFileSync(new URL("../src/ui.html", import.meta.url), "utf8");
const block = html.match(/\/\/ ---- Speech helpers[\s\S]*?\/\/ ---- End speech helpers ----/);
assert.ok(block, "speech helper block not found in ui.html");
const { speechText, speechChunks, pickVoice } = new Function(
  `${block[0]}\nreturn { speechText, speechChunks, pickVoice };`,
)();

// ---- speechText -----------------------------------------------------------

test("speechText drops Chinese characters from place names", () => {
  assert.equal(speechText("Top pick is KANG AND KEE 江纪小炒 for everyone."), "Top pick is KANG AND KEE for everyone.");
});

test("speechText drops emoji and symbols but keeps words, numbers and punctuation", () => {
  assert.equal(speechText("Rated 5.0 ★ and ~14 minutes, 100% fair! 😀"), "Rated 5.0 and ~14 minutes, 100% fair!");
});

test("speechText keeps accented Latin letters, apostrophes and dashes", () => {
  assert.equal(speechText("Café Rôtie isn’t far — about 10 minutes."), "Café Rôtie isn’t far — about 10 minutes.");
});

test("speechText collapses spaces and line breaks", () => {
  assert.equal(speechText("  one   two\n\nthree\t four  "), "one two three four");
});

test("speechText of nothing readable is empty", () => {
  assert.equal(speechText("江纪小炒"), "");
  assert.equal(speechText(""), "");
});

// ---- speechChunks ---------------------------------------------------------

test("speechChunks keeps a short verdict in one piece", () => {
  assert.deepEqual(speechChunks("I settle this one. Go to Kang and Kee."), ["I settle this one. Go to Kang and Kee."]);
});

test("speechChunks splits at sentence ends when the text is long", () => {
  const sentence = (n) => `This is sentence number ${n} of the verdict and it has some words in it.`;
  const text = [1, 2, 3, 4, 5, 6].map(sentence).join(" ");
  const chunks = speechChunks(text, 160);

  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 160, `chunk too long: ${chunk.length}`);
    assert.match(chunk, /[.!?]$/, "chunk should end at a sentence break");
  }
  assert.equal(chunks.join(" "), text);
});

test("speechChunks does not break a sentence at the point in a number", () => {
  const chunks = speechChunks("It is rated 5.0 stars and takes 8.5 minutes. Next sentence.", 45);
  assert.ok(chunks.some((c) => c.includes("rated 5.0 stars")));
  assert.ok(chunks.every((c) => !/\d\.$/.test(c)), `a chunk ended inside a number: ${JSON.stringify(chunks)}`);
});

test("speechChunks cuts a very long sentence at word boundaries", () => {
  const words = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
  const chunks = speechChunks(`${words}.`, 100);

  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.length <= 100);
  assert.equal(chunks.join(" "), `${words}.`);
});

test("speechChunks handles text with no final full stop", () => {
  assert.deepEqual(speechChunks("No full stop at the end"), ["No full stop at the end"]);
});

test("speechChunks returns nothing for empty text", () => {
  assert.deepEqual(speechChunks(""), []);
  assert.deepEqual(speechChunks("   "), []);
});

test("speechChunks handles exclamations and questions", () => {
  assert.deepEqual(speechChunks("Go now! Why wait? Eat well."), ["Go now! Why wait? Eat well."]);
  assert.deepEqual(speechChunks("Go now! Why wait? Eat well.", 12), ["Go now!", "Why wait?", "Eat well."]);
});

// ---- pickVoice ------------------------------------------------------------

const voice = (lang, name = lang) => ({ lang, name });

test("pickVoice prefers Singapore, then British, then Australian, then any English", () => {
  const us = voice("en-US");
  const au = voice("en-AU");
  const gb = voice("en-GB");
  const sg = voice("en-SG");

  assert.equal(pickVoice([us, au, gb, sg]), sg);
  assert.equal(pickVoice([us, au, gb]), gb);
  assert.equal(pickVoice([us, au]), au);
  assert.equal(pickVoice([us]), us);
});

test("pickVoice understands underscores and any letter case", () => {
  const gb = voice("en_GB");
  assert.equal(pickVoice([voice("fr-FR"), gb]), gb);
  assert.equal(pickVoice([voice("EN-sg")]).lang, "EN-sg");
});

test("pickVoice accepts a bare English language code", () => {
  const plain = voice("en");
  assert.equal(pickVoice([voice("de-DE"), plain]), plain);
});

test("pickVoice returns null when the device has no English voice", () => {
  assert.equal(pickVoice([voice("zh-CN"), voice("fr-FR")]), null);
  assert.equal(pickVoice([]), null);
});

test("pickVoice does not mistake other languages that start with e", () => {
  assert.equal(pickVoice([voice("es-ES"), voice("el-GR"), voice("eu")]), null);
});

test("pickVoice skips voices with no language", () => {
  assert.equal(pickVoice([{ name: "mystery" }, { lang: null }]), null);
});

// ---- wiring: speech only ever starts from a click --------------------------

test("the Listen button exists, is a plain button, and starts hidden until the browser can speak", () => {
  assert.match(html, /<button[^>]*id="listen"[^>]*type="button"[^>]*hidden/);
  assert.match(html, /\$\("listen"\)\.hidden = !canSpeak/);
});

test("speak() is called from the Listen click handler and nowhere else", () => {
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  const calls = script
    .replace(/function speak\(/g, "")
    .replace(/speechSynthesis\.speak\(/g, "")
    .match(/\bspeak\(/g);
  assert.equal(calls.length, 1);
  assert.match(script, /\$\("listen"\)\.addEventListener\("click", \(\) => \{[\s\S]*?speak\(currentVerdict\)/);
});

test("a new verdict, leaving the poll and closing the page all stop the speech", () => {
  const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
  assert.match(script, /latest\.id !== verdictId\) \{\s*stopSpeaking\(\)/);
  assert.match(script, /function showHome\(\) \{\s*stopSpeaking\(\)/);
  assert.match(script, /pagehide/);
});
