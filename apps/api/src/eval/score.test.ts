import test from "node:test";
import assert from "node:assert/strict";
import { scorePriority, percentile, type EvalCase, type IncidentExtraction } from "@resqai/schema";

import { scoreCase, summarise } from "./score.js";

/**
 * The scorer decides what "good" means for this system, so its own behaviour
 * has to be pinned down. A metric that silently rewards the wrong thing is
 * worse than no metric, because it comes with the authority of a number.
 */

/* ------------------------------------------------------------------ *
 * Asymmetric priority error
 * ------------------------------------------------------------------ */

test("under-triage is penalised three times as heavily as over-triage", () => {
  // Same distance, opposite directions.
  const under = scorePriority("P0_immediate", "P1_urgent");
  const over = scorePriority("P1_urgent", "P0_immediate");

  assert.equal(under.distance, 1);
  assert.equal(over.distance, 1);

  assert.equal(under.under_triaged, true);
  assert.equal(over.under_triaged, false);

  // Sending a slower response to something that needed a fast one is not the
  // same mistake as the reverse, and a symmetric score would report them as
  // though it were — which is how a system that quietly under-triages passes.
  assert.equal(under.weighted, 3);
  assert.equal(over.weighted, 1);
});

test("distance compounds the weighting", () => {
  assert.equal(scorePriority("P0_immediate", "P3_routine").weighted, 9);
  assert.equal(scorePriority("P3_routine", "P0_immediate").weighted, 3);
});

test("no answer on a P0 scores as maximal under-triage, not as merely missing", () => {
  const silence = scorePriority("P0_immediate", null);

  // A system that declines to classify a life-threatening call has failed in
  // the same direction as one that called it routine. Scoring silence as
  // neutral would let declining to answer look safe.
  assert.equal(silence.under_triaged, true);
  assert.equal(silence.distance, 4);
  assert.equal(silence.weighted, 12);
});

test("an exact match costs nothing", () => {
  const exact = scorePriority("P2_prompt", "P2_prompt");
  assert.equal(exact.distance, 0);
  assert.equal(exact.weighted, 0);
});

/* ------------------------------------------------------------------ *
 * Latency percentiles
 * ------------------------------------------------------------------ */

test("percentiles describe the tail, which is what a mean hides", () => {
  // Nine fast calls and one very slow one. With nearest-rank percentiles the
  // slow call is the 95th percentile of ten samples — it would take twenty
  // samples for it to fall outside p95, which is itself worth knowing when
  // reading a report generated from a small case set.
  const samples = [...Array(9).fill(1000), 60_000];

  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;

  // The mean lands at 6.9 s — an unremarkable-looking number that describes
  // no call that actually happened. Nine took a second; one took a minute.
  assert.equal(mean, 6900);
  assert.equal(percentile(samples, 50), 1000);
  assert.equal(percentile(samples, 95), 60_000);
});

test("percentile of an empty set is zero rather than undefined", () => {
  assert.equal(percentile([], 95), 0);
});

/* ------------------------------------------------------------------ *
 * Case scoring
 * ------------------------------------------------------------------ */

function extraction(overrides: Record<string, unknown> = {}): IncidentExtraction {
  const f = (value: unknown, evidence: string[] = ["s0"]) => ({
    value,
    status: "extracted" as const,
    confidence: 0.9,
    evidence,
  });
  const empty = { value: null, status: "not_stated" as const, confidence: 0, evidence: [] };

  return {
    incident_type: f("fire_structure"),
    priority: f("P0_immediate"),
    agencies: f(["fire", "children"]),
    location: empty,
    people_affected: empty,
    caller_role: empty,
    hazards: f([]),
    children_involved: f(true),
    callback_number: empty,
    summary: "Fire at Shiv Mandir with a child trapped.",
    escalation_triggers: ["life_threat_indicated", "child_involved"],
    overall_confidence: 0.9,
    ...overrides,
  } as unknown as IncidentExtraction;
}

function testCase(overrides: Record<string, unknown> = {}): EvalCase {
  // `expect` is merged field by field and pulled out of the rest. Spreading
  // the overrides wholesale would replace the whole `expect` object this
  // helper had just built defaults for.
  const { expect: expectOverrides, ...rest } = overrides;

  return {
    id: "case-1",
    tests: "a case",
    tags: ["test"],
    channel: "whatsapp",
    utterances: [{ text: "aag lagi hai", speaker: "caller", language: "hi", asr_confidence: null }],
    expect: {
      incident_type: "fire_structure",
      acceptable_types: [],
      priority: "P0_immediate",
      acceptable_priorities: [],
      required_agencies: ["fire"],
      required_escalations: ["life_threat_indicated"],
      life_threat: true,
      life_threat_ambiguous: false,
      must_preserve: [],
      location_unresolvable: true,
      ...((expectOverrides as object | undefined) ?? {}),
    },
    ...rest,
  } as EvalCase;
}

const META = {
  latencyMs: 1200,
  modelId: "test",
  degradedFields: [],
  problems: [],
  error: null,
  validSegmentIds: new Set(["s0"]),
};

test("an acceptable alternative scores as correct", () => {
  const score = scoreCase(
    testCase({ expect: { acceptable_types: ["medical_trauma"] } }),
    extraction({ incident_type: { value: "medical_trauma", status: "extracted", confidence: 0.8, evidence: ["s0"] } }),
    META,
  );

  // Without alternatives the harness measures agreement with the labeller
  // rather than fitness for dispatch.
  assert.equal(score.type_correct, true);
});

test("a missed life threat is flagged even when the type is right", () => {
  const score = scoreCase(
    testCase(),
    extraction({
      priority: { value: "P2_prompt", status: "extracted", confidence: 0.8, evidence: ["s0"] },
      escalation_triggers: [],
    }),
    META,
  );

  assert.equal(score.type_correct, true, "the type was still correct");
  // And yet this is the failure that matters. Averaged into an accuracy
  // figure it would disappear.
  assert.equal(score.missed_life_threat, true);
  assert.equal(score.priority.under_triaged, true);
});

test("a P0 classification counts as flagging a life threat", () => {
  const score = scoreCase(
    testCase(),
    extraction({ escalation_triggers: [] }),
    META,
  );
  // The trigger was absent but the priority says the same thing. Counting
  // this as a miss would punish a system that got the substance right.
  assert.equal(score.missed_life_threat, false);
});

test("over-escalation is counted separately from under-escalation", () => {
  const score = scoreCase(
    testCase(),
    extraction({
      escalation_triggers: ["life_threat_indicated", "child_involved", "hazard_indicated"],
    }),
    META,
  );

  assert.deepEqual(score.missed_escalations, []);
  // A cost, not a harm — and netting the two together would hide which is
  // which.
  assert.ok(score.extra_escalations.length > 0);
});

test("a lost place name is caught", () => {
  const score = scoreCase(
    testCase({ expect: { must_preserve: ["Shiv Mandir"] } }),
    extraction({ summary: "Fire at the Shiva temple with a child trapped." }),
    META,
  );

  // "Shiv Mandir" becoming "Shiva temple" is a silent loss of the most
  // actionable string in the call.
  assert.deepEqual(score.lost_verbatim, ["Shiv Mandir"]);
});

test("a preserved place name passes", () => {
  const score = scoreCase(
    testCase({ expect: { must_preserve: ["Shiv Mandir"] } }),
    extraction(),
    META,
  );
  assert.deepEqual(score.lost_verbatim, []);
});

test("citations pointing at segments that were never sent are counted", () => {
  const score = scoreCase(
    testCase(),
    extraction({
      incident_type: { value: "fire_structure", status: "extracted", confidence: 0.9, evidence: ["s0", "s7"] },
    }),
    META,
  );
  assert.equal(score.invented_evidence, 1);
});

test("a case expecting unclear is satisfied by declining to answer", () => {
  const score = scoreCase(
    testCase({
      expect: {
        incident_type: "unclear",
        priority: "unclear",
        required_agencies: [],
        required_escalations: [],
        life_threat: false,
      },
    }),
    extraction({
      incident_type: { value: null, status: "unclear", confidence: 0, evidence: [] },
      priority: { value: null, status: "unclear", confidence: 0, evidence: [] },
      escalation_triggers: [],
    }),
    META,
  );

  // A set that only accepted a confident answer would reward a model that
  // never admits uncertainty — the exact behaviour this system prevents.
  assert.equal(score.type_correct, true);
  assert.equal(score.priority.weighted, 0);
});

test("a total failure is recorded rather than skipped", () => {
  const score = scoreCase(testCase(), null, {
    ...META,
    error: "model unavailable",
  });

  assert.equal(score.type_correct, false);
  assert.equal(score.missed_life_threat, true);
  assert.equal(score.error, "model unavailable");
});

/* ------------------------------------------------------------------ *
 * Aggregation
 * ------------------------------------------------------------------ */

test("recall denominators come from the cases, not from the results", () => {
  const missing = scoreCase(
    testCase({ expect: { required_escalations: ["life_threat_indicated", "child_involved"] } }),
    extraction({ escalation_triggers: ["life_threat_indicated"] }),
    META,
  );

  const summary = summarise([missing], "test");

  // One of two required triggers fired. Inferring the denominator from the
  // output would have produced a different, unverifiable number.
  assert.equal(missing.required_escalations_count, 2);
  assert.equal(summary.escalation_recall, 0.5);
});

test("the summary keeps safety numbers as counts, not rates", () => {
  const scores = [
    scoreCase(testCase(), extraction({ priority: { value: "P3_routine", status: "extracted", confidence: 0.5, evidence: [] }, escalation_triggers: [] }), META),
    scoreCase(testCase(), extraction(), META),
  ];

  const summary = summarise(scores, "test");

  // A count of one is legible; "50% life-threat recall" invites rounding a
  // real failure into an acceptable-looking percentage.
  assert.equal(summary.missed_life_threats, 1);
  assert.equal(summary.cases, 2);
});

test("a case marked ambiguous scores neither direction as an error", () => {
  const ambiguous = testCase({
    expect: { life_threat: false, life_threat_ambiguous: true },
  });

  // Flagging one.
  const flagged = scoreCase(ambiguous, extraction(), META);
  assert.equal(flagged.false_life_threat, false);

  // And not flagging one.
  const notFlagged = scoreCase(
    ambiguous,
    extraction({
      priority: { value: "P2_prompt", status: "extracted", confidence: 0.8, evidence: ["s0"] },
      escalation_triggers: [],
    }),
    META,
  );
  assert.equal(notFlagged.missed_life_threat, false);
});

test("ambiguity is opt-in and does not weaken an ordinary case", () => {
  // The flag defaults off, so the strict behaviour is what a case gets unless
  // its author deliberately said the judgement was open.
  const strict = scoreCase(
    testCase(),
    extraction({
      priority: { value: "P3_routine", status: "extracted", confidence: 0.5, evidence: [] },
      escalation_triggers: [],
    }),
    META,
  );
  assert.equal(strict.missed_life_threat, true);
});
