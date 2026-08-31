import test from "node:test";
import assert from "node:assert/strict";
import { detectLanguage } from "./detect.js";

test("native Devanagari is detected, and its ambiguity is admitted", () => {
  const d = detectLanguage("आग लग गई है तीसरी मंजिल पर");

  assert.equal(d.script, "devanagari");
  assert.equal(d.language, "hi");
  // Devanagari carries eight scheduled languages. Confidence reflects that.
  assert.equal(d.script_ambiguous, true);
  assert.ok(d.confidence < 0.8, "a shared script should not report near-certainty");
  assert.ok(d.candidates.includes("mr"), "Marathi is a real alternative reading");
});

test("scripts with a single scheduled language report higher confidence", () => {
  const tamil = detectLanguage("தீ விபத்து நடந்துள்ளது");
  assert.equal(tamil.language, "ta");
  assert.equal(tamil.script_ambiguous, false);
  assert.ok(tamil.confidence > 0.9);

  assert.equal(detectLanguage("అగ్ని ప్రమాదం జరిగింది").language, "te");
  assert.equal(detectLanguage("തീപിടുത്തം ഉണ്ടായി").language, "ml");
  assert.equal(detectLanguage("ਅੱਗ ਲੱਗ ਗਈ ਹੈ").language, "pa");
});

test("Hinglish is classified as mixed, not forced into one language", () => {
  const d = detectLanguage("accident hua hai near the ORR flyover, do log injured hain");

  // Calling this Hindi or English would both be wrong and would lose the
  // information that the extractor most needs.
  assert.equal(d.language, "mixed");
  assert.ok(d.confidence >= 0.7);
});

test("romanised Hindi is recognised but never over-trusted", () => {
  const d = detectLanguage("jaldi ambulance bhejo, mera bhai behosh hai");

  assert.equal(d.language, "hi");
  // Latin-script Hindi is a weaker call than native script; it must say so.
  assert.ok(d.confidence <= 0.8);
});

test("plain English is recognised", () => {
  const d = detectLanguage("There is a fire on the third floor, please send help");
  assert.equal(d.language, "en");
  assert.equal(d.script, "latin");
});

test("Devanagari mixed with English is reported as mixed", () => {
  const d = detectLanguage("आग लगी है near the metro station please help");
  assert.equal(d.language, "mixed");
  assert.equal(d.mixed, true);
});

test("unrecognisable Latin text is a weak English guess, not a confident one", () => {
  const d = detectLanguage("MH12 AB 4471");
  assert.equal(d.language, "en");
  assert.ok(d.confidence < 0.5, "a registration plate is not evidence of language");
});

test("empty input is unknown rather than defaulted", () => {
  const d = detectLanguage("   ");
  assert.equal(d.language, "unknown");
  assert.equal(d.confidence, 0);
});
