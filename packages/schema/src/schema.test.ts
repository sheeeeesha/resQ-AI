import test from "node:test";
import assert from "node:assert/strict";

import {
  IncidentExtraction,
  validateSemantics,
  type IncidentExtraction as Extraction,
} from "./extraction.js";
import {
  PRIORITY_RANK,
  type IncidentPriority,
} from "./enums.js";
import {
  checkFieldInvariants,
  isDisplayable,
  isRoutable,
  needsFollowUp,
} from "./field.js";
import { rankCandidates, type LocationCandidate } from "./incident.js";
import { assessQuality, type TranscriptSegment } from "./transcript.js";
import { INCIDENT_EXTRACTION_JSON_SCHEMA } from "./jsonschema.js";

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/** A realistic road traffic accident call, as the extractor would return it. */
function rtaExtraction(): Extraction {
  return {
    incident_type: {
      value: "road_traffic_accident",
      status: "extracted",
      confidence: 0.94,
      evidence: ["s2", "s4"],
    },
    priority: {
      value: "P1_urgent",
      status: "extracted",
      confidence: 0.88,
      evidence: ["s4"],
    },
    agencies: {
      value: ["health", "police"],
      status: "extracted",
      confidence: 0.9,
      evidence: ["s4"],
    },
    location: {
      value: {
        raw: "Outer Ring Road ke paas, Shiv Mandir ke peeche",
        landmark: "Shiv Mandir",
        locality: null,
        city: "Hyderabad",
        street: "Outer Ring Road",
        code: null,
      },
      status: "extracted",
      confidence: 0.71,
      evidence: ["s6"],
    },
    people_affected: {
      value: { min: 2, max: 3 },
      status: "extracted",
      confidence: 0.66,
      evidence: ["s8"],
    },
    caller_role: {
      value: "bystander",
      status: "extracted",
      confidence: 0.82,
      evidence: ["s1"],
    },
    hazards: {
      value: ["ongoing_traffic"],
      status: "extracted",
      confidence: 0.75,
      evidence: ["s6"],
    },
    children_involved: {
      value: null,
      status: "not_stated",
      confidence: 0,
      evidence: [],
    },
    callback_number: {
      value: null,
      status: "not_stated",
      confidence: 0,
      evidence: [],
    },
    summary:
      "Two-vehicle collision on Outer Ring Road near Shiv Mandir. Two to three people injured; traffic still moving past the scene.",
    escalation_triggers: ["hazard_indicated"],
    overall_confidence: 0.81,
  };
}

/* ------------------------------------------------------------------ *
 * Contract
 * ------------------------------------------------------------------ */

test("a realistic extraction parses against the contract", () => {
  const parsed = IncidentExtraction.safeParse(rtaExtraction());
  assert.equal(parsed.success, true);
});

test("free-text severity is rejected — the prototype's core defect", () => {
  const bad = rtaExtraction() as unknown as Record<string, unknown>;
  (bad.priority as Record<string, unknown>).value = "High";

  const parsed = IncidentExtraction.safeParse(bad);
  assert.equal(parsed.success, false);
});

test("an unknown incident type cannot be invented", () => {
  const bad = rtaExtraction() as unknown as Record<string, unknown>;
  (bad.incident_type as Record<string, unknown>).value = "cat stuck in tree";

  assert.equal(IncidentExtraction.safeParse(bad).success, false);
});

test("confidence outside 0-1 is rejected", () => {
  const bad = rtaExtraction() as unknown as Record<string, unknown>;
  (bad.priority as Record<string, unknown>).confidence = 1.4;

  assert.equal(IncidentExtraction.safeParse(bad).success, false);
});

/* ------------------------------------------------------------------ *
 * The original sort bug
 * ------------------------------------------------------------------ */

test("priority sorts most-urgent-first, unlike the prototype's strings", () => {
  // The prototype used Firestore orderBy("criticality", "desc") over the
  // strings High / Medium / Low, which yields Medium, Low, High — putting the
  // most critical incident last on a triage board.
  const legacy = ["High", "Medium", "Low"].sort().reverse();
  assert.deepEqual(legacy, ["Medium", "Low", "High"]);

  const codes: IncidentPriority[] = [
    "P3_routine",
    "P0_immediate",
    "P4_referral",
    "P1_urgent",
    "P2_prompt",
  ];

  // Lexicographic ascending and semantic urgency now agree.
  assert.deepEqual([...codes].sort(), [
    "P0_immediate",
    "P1_urgent",
    "P2_prompt",
    "P3_routine",
    "P4_referral",
  ]);

  // And the explicit rank agrees with both.
  const byRank = [...codes].sort((a, b) => PRIORITY_RANK[a] - PRIORITY_RANK[b]);
  assert.equal(byRank[0], "P0_immediate");
  assert.equal(byRank[byRank.length - 1], "P4_referral");
});

/* ------------------------------------------------------------------ *
 * Confidence gating
 * ------------------------------------------------------------------ */

test("a low-confidence location is not displayed as fact", () => {
  const e = rtaExtraction();

  // 0.71 clears nothing: it is below the display threshold of 0.75.
  assert.equal(isDisplayable(e.location), false);
  assert.equal(isRoutable(e.location), false);
  assert.equal(needsFollowUp(e.location), true);

  // The incident type, at 0.94, is solid enough for both.
  assert.equal(isDisplayable(e.incident_type), true);
  assert.equal(isRoutable(e.incident_type), true);
});

test("not_stated is distinguishable from a confident value", () => {
  const e = rtaExtraction();
  assert.equal(e.children_involved.status, "not_stated");
  assert.equal(e.children_involved.value, null);
  assert.equal(needsFollowUp(e.children_involved), true);
});

test("field invariants catch a null value marked extracted", () => {
  const problems = checkFieldInvariants("priority", {
    value: null,
    status: "extracted",
    confidence: 0.9,
    evidence: [],
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /null value/);
});

/* ------------------------------------------------------------------ *
 * Semantic validation
 * ------------------------------------------------------------------ */

test("a clean extraction reports no semantic problems", () => {
  assert.deepEqual(validateSemantics(rtaExtraction()), []);
});

test("an inverted people range is caught", () => {
  const e = rtaExtraction();
  e.people_affected.value = { min: 7, max: 3 };
  assert.ok(validateSemantics(e).some((p) => /exceeds max/.test(p)));
});

test("children involved without the children lane is caught", () => {
  const e = rtaExtraction();
  e.children_involved = {
    value: true,
    status: "extracted",
    confidence: 0.9,
    evidence: ["s9"],
  };
  assert.ok(validateSemantics(e).some((p) => /children lane/.test(p)));
});

test("hazards without an escalation trigger are caught", () => {
  const e = rtaExtraction();
  e.escalation_triggers = [];
  assert.ok(validateSemantics(e).some((p) => /hazard_indicated/.test(p)));
});

test("a confident classification citing no evidence is caught", () => {
  const e = rtaExtraction();
  e.incident_type.evidence = [];
  assert.ok(validateSemantics(e).some((p) => /cites no evidence/.test(p)));
});

/* ------------------------------------------------------------------ *
 * Location ranking
 * ------------------------------------------------------------------ */

test("device location outranks anything said on the call", () => {
  const candidates: LocationCandidate[] = [
    {
      source: "stated_landmark",
      point: { latitude: 17.44, longitude: 78.39 },
      accuracy_m: null,
      label: "Behind Shiv Mandir",
      trust: 35,
      obtained_at: "2026-08-30T09:00:10.000Z",
    },
    {
      source: "device_els",
      point: { latitude: 17.4401, longitude: 78.3912 },
      accuracy_m: 48,
      label: "Handset location",
      trust: 100,
      obtained_at: "2026-08-30T09:00:02.000Z",
    },
    {
      source: "network_cell",
      point: { latitude: 17.45, longitude: 78.4 },
      accuracy_m: 1400,
      label: "Cell sector",
      trust: 60,
      obtained_at: "2026-08-30T09:00:01.000Z",
    },
  ];

  const ranked = rankCandidates(candidates);
  assert.equal(ranked[0]!.source, "device_els");
  assert.equal(ranked[1]!.source, "network_cell");
  assert.equal(ranked[2]!.source, "stated_landmark");

  // Nothing was discarded. The prototype kept only geocoder results[0].
  assert.equal(ranked.length, 3);
});

/* ------------------------------------------------------------------ *
 * Transcript quality
 * ------------------------------------------------------------------ */

function seg(
  i: number,
  conf: number | null,
  speaker: TranscriptSegment["speaker"] = "caller",
): TranscriptSegment {
  return {
    id: `s${i}`,
    index: i,
    speaker,
    text: "…",
    text_en: null,
    language: "mixed",
    asr_confidence: conf,
    start_ms: null,
    end_ms: null,
    received_at: "2026-08-30T09:00:00.000Z",
    is_final: true,
  };
}

test("poor audio marks the transcript degraded", () => {
  const q = assessQuality([seg(0, 0.4), seg(1, 0.5), seg(2, 0.55)]);
  assert.equal(q.degraded, true);
  assert.equal(q.low_confidence_ratio, 1);
  assert.equal(q.segment_count, 3);
});

test("good audio does not mark the transcript degraded", () => {
  const q = assessQuality([seg(0, 0.95), seg(1, 0.91), seg(2, 0.88)]);
  assert.equal(q.degraded, false);
  assert.equal(q.low_confidence_ratio, 0);
});

test("text channels carry no ASR confidence and are never degraded", () => {
  const q = assessQuality([seg(0, null), seg(1, null)]);
  assert.equal(q.mean_asr_confidence, null);
  assert.equal(q.degraded, false);
});

test("only caller speech is scored, not the operator", () => {
  const q = assessQuality([
    seg(0, 0.4),
    seg(1, 0.99, "call_taker"),
    seg(2, 0.99, "ai_agent"),
  ]);
  assert.equal(q.segment_count, 1);
  assert.equal(q.mean_asr_confidence, 0.4);
});

/* ------------------------------------------------------------------ *
 * Decoding grammar
 * ------------------------------------------------------------------ */

test("the emitted JSON Schema is safe for constrained decoding", () => {
  const s = INCIDENT_EXTRACTION_JSON_SCHEMA;
  const json = JSON.stringify(s);

  // Gemini's structured-output subset does not resolve $ref.
  assert.equal(json.includes("$ref"), false);
  assert.equal(json.includes("$defs"), false);

  // Strict decoders require every property listed and extras forbidden.
  assert.equal(s.additionalProperties, false);
  assert.deepEqual(
    (s.required as string[]).sort(),
    Object.keys(s.properties as object).sort(),
  );

  // Nested objects must satisfy the same rules.
  const priority = (s.properties as Record<string, Record<string, unknown>>)
    .priority!;
  assert.equal(priority.additionalProperties, false);
  assert.deepEqual(
    (priority.required as string[]).sort(),
    ["confidence", "evidence", "status", "value"],
  );
});
