import test from "node:test";
import assert from "node:assert/strict";
import type { IncidentExtraction } from "@resqai/schema";
import { asProposal, emptyField } from "@resqai/schema";

import { mergeExtraction, chooseSummary } from "./merge.js";
import { evaluateEscalation, mergeTriggers } from "./escalation.js";

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

function extractionWith(overrides: Partial<Record<string, unknown>> = {}): IncidentExtraction {
  const f = (value: unknown) => ({
    value,
    status: "extracted" as const,
    confidence: 0.9,
    evidence: ["s0"],
  });
  const empty = { value: null, status: "not_stated" as const, confidence: 0, evidence: [] };

  return {
    incident_type: f("fire_structure"),
    priority: f("P1_urgent"),
    agencies: f(["fire"]),
    location: empty,
    people_affected: empty,
    caller_role: f("bystander"),
    hazards: f([]),
    children_involved: empty,
    callback_number: empty,
    summary: "Fire reported in a building.",
    escalation_triggers: [],
    overall_confidence: 0.9,
    ...overrides,
  } as unknown as IncidentExtraction;
}

/** A stored field a human has confirmed. */
function humanOwned(value: unknown) {
  return {
    value,
    status: "extracted" as const,
    confidence: 1,
    evidence: [],
    review: {
      state: "human_corrected" as const,
      reviewed_by: "op-1",
      reviewed_at: "2026-08-30T09:00:00.000Z",
      override_reason: "wrong_classification" as const,
      superseded_value: null,
    },
  };
}

/* ------------------------------------------------------------------ *
 * The merge rule
 * ------------------------------------------------------------------ */

test("unreviewed fields are updated by a new pass", () => {
  const current = {
    incident_type: emptyField(),
    priority: emptyField(),
    agencies: emptyField(),
    people_affected: emptyField(),
    caller_role: emptyField(),
    hazards: emptyField(),
    children_involved: emptyField(),
    callback_number: emptyField(),
  };

  const merged = mergeExtraction(current, extractionWith());

  assert.equal(merged.fields.incident_type!.value, "fire_structure");
  assert.ok(merged.updated.includes("incident_type"));
  assert.deepEqual(merged.preserved, []);
});

test("a human decision is never overwritten by a later pass", () => {
  const current = {
    incident_type: humanOwned("crime_assault"),
    priority: emptyField(),
    agencies: emptyField(),
    people_affected: emptyField(),
    caller_role: emptyField(),
    hazards: emptyField(),
    children_involved: emptyField(),
    callback_number: emptyField(),
  };

  const merged = mergeExtraction(current, extractionWith());

  // The operator set this. A model that later disagrees does not get to
  // silently undo their work — that is a safety failure, not a sync bug.
  assert.equal(merged.fields.incident_type!.value, "crime_assault");
  assert.equal(merged.fields.incident_type!.review.state, "human_corrected");
  assert.ok(merged.preserved.includes("incident_type"));
  assert.ok(!merged.updated.includes("incident_type"));

  // But the disagreement is surfaced rather than discarded.
  assert.equal(merged.contested.length, 1);
  assert.equal(merged.contested[0]!.field, "incident_type");
  assert.equal(merged.contested[0]!.humanValue, "crime_assault");
  assert.equal(merged.contested[0]!.modelValue, "fire_structure");
});

test("agreement with a human decision is not reported as contested", () => {
  const current = {
    incident_type: humanOwned("fire_structure"),
    priority: emptyField(),
    agencies: emptyField(),
    people_affected: emptyField(),
    caller_role: emptyField(),
    hazards: emptyField(),
    children_involved: emptyField(),
    callback_number: emptyField(),
  };

  const merged = mergeExtraction(current, extractionWith());
  assert.equal(merged.contested.length, 0);
});

test("array fields compare as sets, so ordering is not a disagreement", () => {
  const current = {
    agencies: humanOwned(["police", "health"]),
    incident_type: emptyField(),
    priority: emptyField(),
    people_affected: emptyField(),
    caller_role: emptyField(),
    hazards: emptyField(),
    children_involved: emptyField(),
    callback_number: emptyField(),
  };

  const merged = mergeExtraction(
    current,
    extractionWith({
      agencies: { value: ["health", "police"], status: "extracted", confidence: 0.9, evidence: ["s0"] },
    }),
  );

  // Reporting this as contested on every pass would train operators to ignore
  // the signal entirely.
  assert.equal(merged.contested.length, 0);
});

test("an empty summary from a degraded pass does not wipe a good one", () => {
  assert.equal(chooseSummary("Fire on the third floor.", ""), "Fire on the third floor.");
  assert.equal(chooseSummary("Fire on the third floor.", "   "), "Fire on the third floor.");
  assert.equal(chooseSummary("old", "new and better"), "new and better");
});

/* ------------------------------------------------------------------ *
 * Escalation
 * ------------------------------------------------------------------ */

const BASE = {
  quality: null,
  systemDegraded: false,
  problems: [],
  languageSupported: true,
};

test("a caller reporting their own emergency escalates", () => {
  const triggers = evaluateEscalation({
    ...BASE,
    extraction: extractionWith({
      caller_role: { value: "victim", status: "extracted", confidence: 0.9, evidence: ["s0"] },
    }),
  });
  assert.ok(triggers.includes("caller_is_involved"));
});

test("a P0 classification escalates", () => {
  const triggers = evaluateEscalation({
    ...BASE,
    extraction: extractionWith({
      priority: { value: "P0_immediate", status: "extracted", confidence: 0.95, evidence: ["s0"] },
    }),
  });
  assert.ok(triggers.includes("life_threat_indicated"));
});

test("hazards escalate", () => {
  const triggers = evaluateEscalation({
    ...BASE,
    extraction: extractionWith({
      hazards: { value: ["weapon_present"], status: "extracted", confidence: 0.9, evidence: ["s0"] },
    }),
  });
  assert.ok(triggers.includes("hazard_indicated"));
});

test("a child involved escalates", () => {
  const triggers = evaluateEscalation({
    ...BASE,
    extraction: extractionWith({
      children_involved: { value: true, status: "extracted", confidence: 0.9, evidence: ["s0"] },
    }),
  });
  assert.ok(triggers.includes("child_involved"));
});

test("low overall confidence escalates", () => {
  const triggers = evaluateEscalation({
    ...BASE,
    extraction: extractionWith({ overall_confidence: 0.4 }),
  });
  assert.ok(triggers.includes("low_confidence"));
});

test("no extraction at all escalates", () => {
  const triggers = evaluateEscalation({ ...BASE, extraction: null });
  assert.ok(triggers.includes("low_confidence"));
});

test("an unsupported language escalates", () => {
  const triggers = evaluateEscalation({
    ...BASE,
    extraction: extractionWith(),
    languageSupported: false,
  });
  assert.ok(triggers.includes("language_unsupported"));
});

test("semantic problems escalate", () => {
  const triggers = evaluateEscalation({
    ...BASE,
    extraction: extractionWith(),
    problems: ["children_involved is true but children lane not routed"],
  });
  assert.ok(triggers.includes("contradictory_information"));
});

test("degraded ASR escalates on voice, and quality is not consulted on text", () => {
  const degradedQuality = {
    mean_asr_confidence: 0.4,
    low_confidence_ratio: 0.9,
    languages_detected: [],
    degraded: true,
    segment_count: 3,
  };

  assert.ok(
    evaluateEscalation({ ...BASE, extraction: extractionWith(), quality: degradedQuality })
      .includes("asr_quality_poor"),
  );

  // Text channels pass null — there is no recognition step to be poor at.
  assert.ok(
    !evaluateEscalation({ ...BASE, extraction: extractionWith(), quality: null })
      .includes("asr_quality_poor"),
  );
});

test("a clean, confident extraction raises nothing", () => {
  const triggers = evaluateEscalation({
    ...BASE,
    extraction: extractionWith({ overall_confidence: 0.95 }),
  });
  assert.deepEqual(triggers, []);
});

test("the model's own triggers are honoured", () => {
  const triggers = evaluateEscalation({
    ...BASE,
    extraction: extractionWith({
      overall_confidence: 0.95,
      escalation_triggers: ["caller_requested_human"],
    }),
  });
  assert.ok(triggers.includes("caller_requested_human"));
});

test("escalation is one-way — merging never removes a trigger", () => {
  const existing = ["life_threat_indicated" as const, "hazard_indicated" as const];
  const merged = mergeTriggers(existing, ["low_confidence"]);

  // A model that grew more confident on a longer transcript is not evidence
  // that the earlier concern was wrong.
  assert.ok(merged.includes("life_threat_indicated"));
  assert.ok(merged.includes("hazard_indicated"));
  assert.ok(merged.includes("low_confidence"));

  assert.deepEqual(mergeTriggers(existing, []), existing);
});

test("triggers are ordered so a truncated list keeps what matters most", () => {
  const merged = mergeTriggers(
    ["low_confidence"],
    ["life_threat_indicated", "asr_quality_poor", "child_involved"],
  );
  assert.equal(merged[0], "life_threat_indicated");
  assert.equal(merged[merged.length - 1], "low_confidence");
});
