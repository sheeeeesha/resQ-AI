import test from "node:test";
import assert from "node:assert/strict";

import { redact, toDrafts } from "./import-legacy.js";

/**
 * Importing real transcripts.
 *
 * Two properties matter more than the conversion itself: identifiers do not
 * survive into a file someone will open repeatedly, and no draft can be
 * mistaken for a labelled case.
 */

/* ------------------------------------------------------------------ *
 * Redaction
 * ------------------------------------------------------------------ */

test("an Indian mobile number is removed in the forms callers actually say it", () => {
  for (const number of [
    "9876543210",
    "+919876543210",
    "+91 9876543210",
    "91-9876543210",
  ]) {
    const { text, removed } = redact(`mera number ${number} hai`);
    assert.ok(!/\d{10}/.test(text), `${number} survived as ${text}`);
    assert.ok(removed.includes("phone"));
  }
});

test("redaction keeps the shape of the sentence", () => {
  const { text } = redact("call me on 9876543210 please");

  // "call me on [phone] please" and "call me on please" read differently to a
  // model, and the second would quietly change what the case tests.
  assert.equal(text, "call me on [phone] please");
});

test("Aadhaar, vehicle registrations and emails are removed", () => {
  assert.match(redact("aadhaar 1234 5678 9012").text, /\[id-number\]/);
  assert.match(redact("vehicle MH12AB4471 hit us").text, /\[vehicle\]/);
  assert.match(redact("write to me at a.sharma@example.in").text, /\[email\]/);
});

test("what the emergency is about is left entirely alone", () => {
  const original =
    "ORR ke paas Shiv Mandir ke peeche accident hua hai, do teen log ghayal hain";
  const { text, removed } = redact(original);

  // Place names are the most actionable thing in a transcript. Redaction that
  // touched them would destroy the value the export exists for.
  assert.equal(text, original);
  assert.deepEqual(removed, []);
});

test("a house number is not mistaken for a phone number", () => {
  const { text } = redact("plot 12, road number 4, Banjara Hills");
  assert.equal(text, "plot 12, road number 4, Banjara Hills");
});

/* ------------------------------------------------------------------ *
 * Drafting
 * ------------------------------------------------------------------ */

test("utterances from one call become one case", () => {
  const { drafts } = toDrafts([
    { id: "1", callId: "call-a", message: "aag lag gayi hai", speaker: "caller" },
    { id: "2", callId: "call-a", message: "teesri manzil par", speaker: "caller" },
    { id: "3", callId: "call-b", message: "accident hua hai", speaker: "caller" },
  ]);

  assert.equal(drafts.length, 2);
  // How a classification develops across a conversation is the interesting
  // behaviour; one line out of context tests almost nothing.
  assert.equal(drafts.find((d) => d.utterances.length === 2)?.utterances.length, 2);
});

test("every expected value is a placeholder, never a guess", () => {
  const { drafts } = toDrafts([
    { id: "1", callId: "c", message: "building mein aag lagi hai", speaker: "caller" },
  ]);

  const expected = drafts[0]!.expect;
  // Filling these in from the transcript would be labelling the set with the
  // same reasoning the set is meant to test.
  assert.equal(expected.incident_type, "NEEDS_LABEL");
  assert.equal(expected.priority, "NEEDS_LABEL");
  assert.equal(drafts[0]!.tests, "NEEDS_LABEL");
  assert.ok(drafts[0]!.tags.includes("needs-label"));
});

test("a call with nothing from the caller is skipped", () => {
  const { drafts, skipped } = toDrafts([
    { id: "1", callId: "c", message: "how can I help?", speaker: "call_taker" },
  ]);

  // Nothing a caller said means nothing to classify.
  assert.equal(drafts.length, 0);
  assert.equal(skipped, 1);
});

test("ids are stable across re-imports and carry no original reference", () => {
  const records = [
    { id: "1", callId: "call-xyz", message: "aag lagi hai", speaker: "caller" },
  ];

  const first = toDrafts(records).drafts[0]!;
  const second = toDrafts(records).drafts[0]!;

  // Re-running the import must not renumber a set someone is part-way through
  // labelling.
  assert.equal(first.id, second.id);
  // And the id must not leak the original call reference into a file that may
  // be shared more widely than the export.
  assert.ok(!first.id.includes("call-xyz"));
});

test("language is detected per draft so a labeller can prioritise", () => {
  const { drafts } = toDrafts([
    { id: "1", callId: "a", message: "आग लग गई है, मदद भेजो", speaker: "caller" },
    { id: "2", callId: "b", message: "there is a fire on the third floor", speaker: "caller" },
  ]);

  const languages = drafts.map((d) => d._import.detected_language);
  assert.ok(languages.includes("hi"));
  assert.ok(languages.includes("en"));
});

test("a thin single-utterance draft is tagged as such", () => {
  const { drafts } = toDrafts([
    { id: "1", message: "help", speaker: "caller" },
  ]);
  // Visible to whoever labels it, so they can see why it is thin rather than
  // discovering it after writing an expectation.
  assert.ok(drafts[0]!.tags.includes("single-utterance"));
});

test("redactions are reported per draft", () => {
  const { drafts } = toDrafts([
    {
      id: "1",
      callId: "c",
      message: "aag lagi hai, mera number 9876543210 hai",
      speaker: "caller",
    },
  ]);

  assert.deepEqual(drafts[0]!._import.redacted, ["phone"]);
  assert.match(drafts[0]!.utterances[0]!.text, /\[phone\]/);
});

test("recognition confidence is null rather than invented", () => {
  const { drafts } = toDrafts([
    { id: "1", callId: "c", message: "aag lagi hai", speaker: "caller" },
  ]);

  // Legacy records carry no confidence. A default would feed the quality
  // assessment and the escalation decision a number nobody measured.
  assert.equal(drafts[0]!.utterances[0]!.asr_confidence, null);
});

test("vendor speaker labels are normalised at the boundary", () => {
  const { drafts } = toDrafts([
    { id: "1", callId: "c", message: "aag lagi hai", speaker: "user" },
    { id: "2", callId: "c", message: "help is coming", speaker: "assistant" },
  ]);

  // The same mapping the intake adapters apply, and for the same reason: the
  // prototype filtered on the literal string "caller" against a feed that may
  // never have used it.
  assert.equal(drafts[0]!.utterances[0]!.speaker, "caller");
  assert.equal(drafts[0]!.utterances[1]!.speaker, "call_taker");
});
