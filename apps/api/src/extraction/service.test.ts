import test from "node:test";
import assert from "node:assert/strict";
import type { z } from "zod";
import type { TranscriptSegment } from "@resqai/schema";

import { ExtractionService, recoverExtraction, pruneInvalidEvidence } from "./service.js";
import { ExtractionUnavailable, type ExtractionProvider, type ExtractionResponse } from "./provider.js";
import { RuleBasedExtractionProvider } from "./rule-based.js";

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

function seg(index: number, text: string): TranscriptSegment {
  return {
    id: `s${index}`,
    index,
    speaker: "caller",
    text,
    text_en: null,
    language: "mixed",
    asr_confidence: null,
    start_ms: null,
    end_ms: null,
    received_at: "2026-08-30T09:00:00.000Z",
    is_final: true,
  };
}

const SEGMENTS = [
  seg(0, "aag lag gayi hai building mein"),
  seg(1, "teesri manzil par, do log phanse hain"),
];

/**
 * Returns whatever it is given, so the service's handling can be tested.
 *
 * `structuredOutput` defaults to true: these fixtures stand in for a provider
 * that honoured the schema, and the cases that matter here are about what the
 * service does with the *content*, not with the transport.
 */
class StubProvider implements ExtractionProvider {
  readonly modelId = "stub";
  constructor(
    private readonly response: Omit<ExtractionResponse, "structuredOutput"> | Error,
  ) {}
  async extract<T extends z.ZodType>(_r: {
    prompt: string;
    schema: T;
  }): Promise<ExtractionResponse> {
    if (this.response instanceof Error) throw this.response;
    return { structuredOutput: true, ...this.response };
  }
}

function validExtraction(overrides: Record<string, unknown> = {}) {
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
    agencies: f(["fire"]),
    location: f({
      raw: "building mein teesri manzil",
      landmark: null,
      locality: null,
      city: null,
      street: null,
      code: null,
    }),
    people_affected: f({ min: 2, max: 2 }, ["s1"]),
    caller_role: f("bystander"),
    hazards: f(["fire_spreading"]),
    children_involved: empty,
    callback_number: empty,
    summary: "Fire on the third floor with two people trapped.",
    escalation_triggers: ["life_threat_indicated", "hazard_indicated"],
    overall_confidence: 0.88,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ *
 * Exit criterion: malformed output cannot enter the database
 * ------------------------------------------------------------------ */

test("a well-formed extraction passes through intact", async () => {
  const service = new ExtractionService({
    provider: new StubProvider({
      parsed: validExtraction(),
      rawText: null,
      latencyMs: 120,
    }),
  });

  const outcome = await service.run(SEGMENTS);

  assert.equal(outcome.error, null);
  assert.equal(outcome.core?.incident_type.value, "fire_structure");
  assert.deepEqual(outcome.degradedFields, []);
  assert.deepEqual(outcome.problems, []);
});

test("output that is not an object yields no core, never a partial write", async () => {
  const service = new ExtractionService({
    provider: new StubProvider({ parsed: "not json", rawText: "not json", latencyMs: 5 }),
  });

  const outcome = await service.run(SEGMENTS);
  assert.equal(outcome.core, null);
  assert.ok(outcome.error);
});

test("an invented enum value cannot survive", async () => {
  const service = new ExtractionService({
    provider: new StubProvider({
      parsed: validExtraction({
        priority: { value: "VERY URGENT", status: "extracted", confidence: 0.9, evidence: ["s0"] },
      }),
      rawText: null,
      latencyMs: 5,
    }),
  });

  const outcome = await service.run(SEGMENTS);

  // The bad field is quarantined; it does not reach the record as a value.
  assert.equal(outcome.core?.priority.value, null);
  assert.equal(outcome.core?.priority.status, "unclear");
});

/* ------------------------------------------------------------------ *
 * Exit criterion: a failure degrades one field, not the record
 * ------------------------------------------------------------------ */

test("one malformed field costs one field, not the whole extraction", async () => {
  const service = new ExtractionService({
    provider: new StubProvider({
      parsed: validExtraction({
        people_affected: { value: { min: "two", max: "three" }, status: "extracted", confidence: 0.7, evidence: [] },
      }),
      rawText: null,
      latencyMs: 5,
    }),
  });

  const outcome = await service.run(SEGMENTS);

  // The record survives.
  assert.ok(outcome.core, "the extraction must survive one bad field");
  assert.equal(outcome.core!.incident_type.value, "fire_structure");
  assert.equal(outcome.core!.priority.value, "P0_immediate");
  assert.equal(outcome.core!.agencies.value?.[0], "fire");

  // Only the broken field is lost, and its loss is explicit rather than silent.
  assert.deepEqual(outcome.degradedFields, ["people_affected"]);
  assert.equal(outcome.core!.people_affected.value, null);
  assert.equal(outcome.core!.people_affected.status, "unclear");
});

test("a degraded pass escalates itself", async () => {
  const service = new ExtractionService({
    provider: new StubProvider({
      parsed: validExtraction({ caller_role: { value: 42 } }),
      rawText: null,
      latencyMs: 5,
    }),
  });

  const outcome = await service.run(SEGMENTS);
  // A pass that damaged its own output is exactly when a person should look.
  assert.ok(outcome.core!.escalation_triggers.includes("low_confidence"));
});

test("several broken fields still leave the rest usable", async () => {
  const service = new ExtractionService({
    provider: new StubProvider({
      parsed: validExtraction({
        caller_role: { value: "bystander" }, // missing status/confidence/evidence
        hazards: "not an envelope",
        children_involved: null,
      }),
      rawText: null,
      latencyMs: 5,
    }),
  });

  const outcome = await service.run(SEGMENTS);

  assert.ok(outcome.core);
  assert.equal(outcome.core!.incident_type.value, "fire_structure");
  assert.equal(outcome.degradedFields.length, 3);
});

test("a provider failure is reported as retryable rather than swallowed", async () => {
  const service = new ExtractionService({
    provider: new StubProvider(new ExtractionUnavailable("stub", "rate limited", true)),
  });

  const outcome = await service.run(SEGMENTS);
  assert.equal(outcome.core, null);
  assert.equal(outcome.retryable, true);
  assert.match(outcome.error!, /rate limited/);
});

/* ------------------------------------------------------------------ *
 * Exit criterion: cited evidence is real
 * ------------------------------------------------------------------ */

test("citations pointing at segments that were never sent are stripped", async () => {
  const service = new ExtractionService({
    provider: new StubProvider({
      parsed: validExtraction({
        incident_type: {
          value: "fire_structure",
          status: "extracted",
          confidence: 0.95,
          evidence: ["s0", "s47"], // s47 does not exist
        },
      }),
      rawText: null,
      latencyMs: 5,
    }),
  });

  const outcome = await service.run(SEGMENTS);

  // A hallucinated citation is worse than none — it looks like provenance and
  // leads a reviewer to a segment that is not there.
  assert.deepEqual(outcome.core!.incident_type.evidence, ["s0"]);
  assert.ok(outcome.problems.some((p) => /s47/.test(p)));
});

test("a confident claim left with no evidence is flagged", () => {
  const extraction = {
    incident_type: { status: "extracted", confidence: 0.95, evidence: ["s99"] },
  };
  const problems = pruneInvalidEvidence(extraction, new Set(["s0"]));

  assert.ok(problems.some((p) => /not in transcript/.test(p)));
  assert.ok(problems.some((p) => /no surviving evidence/.test(p)));
});

test("valid citations are left alone", () => {
  const extraction = {
    incident_type: { status: "extracted", confidence: 0.9, evidence: ["s0", "s1"] },
  };
  assert.deepEqual(pruneInvalidEvidence(extraction, new Set(["s0", "s1"])), []);
});

/* ------------------------------------------------------------------ *
 * Semantic validation
 * ------------------------------------------------------------------ */

test("semantic contradictions are recorded, not raised", async () => {
  const service = new ExtractionService({
    provider: new StubProvider({
      parsed: validExtraction({
        children_involved: { value: true, status: "extracted", confidence: 0.9, evidence: ["s0"] },
        // children_involved is true but the children lane is not routed
        agencies: { value: ["fire"], status: "extracted", confidence: 0.9, evidence: ["s0"] },
      }),
      rawText: null,
      latencyMs: 5,
    }),
  });

  const outcome = await service.run(SEGMENTS);

  // On a live contact a partial extraction beats no extraction, so this is a
  // logged problem rather than a thrown error.
  assert.ok(outcome.core, "a contradiction must not discard the extraction");
  assert.ok(outcome.problems.some((p) => /children lane/.test(p)));
});

/* ------------------------------------------------------------------ *
 * Recovery unit
 * ------------------------------------------------------------------ */

test("recovery salvages JSON wrapped in prose", () => {
  const wrapped = "Here is the result:\n" + JSON.stringify(validExtraction());
  const result = recoverExtraction(null, wrapped);
  assert.ok(result.core);
  assert.equal(result.core!.incident_type.value, "fire_structure");
});

test("recovery gives up cleanly on unsalvageable text", () => {
  const result = recoverExtraction(null, "the model said nothing useful");
  assert.equal(result.core, null);
});

test("empty transcript is reported rather than sent to the model", async () => {
  const service = new ExtractionService({
    provider: new StubProvider(new Error("should never be called")),
  });
  const outcome = await service.run([]);
  assert.equal(outcome.core, null);
  assert.match(outcome.error!, /no final segments/);
});

/* ------------------------------------------------------------------ *
 * Rule-based fallback
 * ------------------------------------------------------------------ */

test("the rule-based fallback classifies Hinglish and always escalates", async () => {
  const service = new ExtractionService({ provider: new RuleBasedExtractionProvider() });
  const outcome = await service.run(SEGMENTS);

  assert.equal(outcome.core?.incident_type.value, "fire_structure");
  // It matches words; it does not understand. Everything it says is low
  // confidence and hands the contact to a person.
  assert.ok(outcome.core!.incident_type.confidence <= 0.5);
  assert.ok(outcome.core!.escalation_triggers.includes("system_degraded"));
});

test("the rule-based fallback cites the segments it actually matched", async () => {
  const service = new ExtractionService({ provider: new RuleBasedExtractionProvider() });
  const outcome = await service.run(SEGMENTS);

  // "aag" appears in s0 only.
  assert.deepEqual(outcome.core!.incident_type.evidence, ["s0"]);
});

test("the rule-based fallback admits when it recognises nothing", async () => {
  const service = new ExtractionService({ provider: new RuleBasedExtractionProvider() });
  const outcome = await service.run([seg(0, "hello is anyone there")]);

  assert.equal(outcome.core?.incident_type.value, null);
  assert.equal(outcome.core?.incident_type.status, "not_stated");
  assert.equal(outcome.core?.overall_confidence, 0);
});
