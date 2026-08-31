import {
  scorePriority,
  type EvalCase,
  type IncidentExtraction,
  type PriorityError,
} from "@resqai/schema";

/**
 * Scoring one case.
 *
 * The metrics here are chosen by the domain, not borrowed from classification
 * benchmarks. Three departures from the obvious formulation, each because the
 * obvious one would hide a failure that matters:
 *
 *  1. **Priority error is asymmetric.** Under-triage and over-triage are not
 *     the same mistake and are not scored as though they were.
 *
 *  2. **Missed life threats get their own number.** Averaged into an accuracy
 *     figure, the one failure with irreversible consequences disappears into
 *     the noise of ninety correct classifications.
 *
 *  3. **Escalation is measured as recall, not accuracy.** Over-escalating is a
 *     cost; under-escalating is a harm. They are counted separately so the
 *     trade-off is visible rather than netted out.
 */

export interface CaseScore {
  case_id: string;
  tags: string[];

  /** Null when the pass produced nothing at all. */
  extraction: IncidentExtraction | null;

  type_correct: boolean;
  type_actual: string | null;

  priority: PriorityError;
  priority_actual: string | null;

  /** True when a life threat was present and the system did not flag it. */
  missed_life_threat: boolean;
  /** True when no life threat was present and the system flagged one. */
  false_life_threat: boolean;

  /**
   * Escalation triggers required but absent. Empty is the goal.
   *
   * The required count travels alongside, because a recall figure whose
   * denominator is inferred from the result is a figure nobody can check.
   */
  missed_escalations: string[];
  required_escalations_count: number;
  /** Triggers raised beyond those required. A cost, not a harm. */
  extra_escalations: string[];

  missing_agencies: string[];
  required_agencies_count: number;

  /** Verbatim strings the transcript required and the output lost. */
  lost_verbatim: string[];
  required_verbatim_count: number;

  degraded_fields: string[];
  problems: string[];
  /** Citations pointing at segments that were never sent. */
  invented_evidence: number;

  latency_ms: number;
  model_id: string;
  error: string | null;
}

export function scoreCase(
  testCase: EvalCase,
  extraction: IncidentExtraction | null,
  meta: {
    latencyMs: number;
    modelId: string;
    degradedFields: string[];
    problems: string[];
    error: string | null;
    /** Segment ids that were actually sent, for checking citations. */
    validSegmentIds: Set<string>;
  },
): CaseScore {
  const expect = testCase.expect;

  const typeActual = extraction?.incident_type.value ?? null;
  const priorityActual = extraction?.priority.value ?? null;

  /*
   * A classification counts as correct if it matches the label or any
   * alternative a competent operator might defensibly choose. Without the
   * alternatives this measures agreement with whoever wrote the label rather
   * than fitness for dispatch — "accident with someone hurt" is legitimately
   * either a road traffic accident or a trauma call.
   */
  const acceptableTypes = new Set<string>([
    expect.incident_type,
    ...expect.acceptable_types,
  ]);
  // An expected "unclear" is also satisfied by the system declining to answer,
  // which is the same admission expressed as an absent value.
  const typeCorrect =
    expect.incident_type === "unclear"
      ? typeActual === null || acceptableTypes.has(typeActual)
      : typeActual !== null && acceptableTypes.has(typeActual);

  const acceptablePriorities = new Set<string>([
    expect.priority,
    ...expect.acceptable_priorities,
  ]);

  // Within the acceptable band the error is zero; outside it, distance and
  // direction both count.
  const priority: PriorityError =
    priorityActual !== null && acceptablePriorities.has(priorityActual)
      ? { distance: 0, under_triaged: false, weighted: 0 }
      : expect.priority === "unclear"
        ? { distance: 0, under_triaged: false, weighted: 0 }
        : scorePriority(expect.priority, priorityActual);

  const triggers = new Set(extraction?.escalation_triggers ?? []);
  const flaggedLifeThreat =
    triggers.has("life_threat_indicated") || priorityActual === "P0_immediate";

  const missedEscalations = expect.required_escalations.filter(
    (trigger) => !triggers.has(trigger),
  );
  const extraEscalations = [...triggers].filter(
    (trigger) => !expect.required_escalations.includes(trigger),
  );

  const agencies = new Set(extraction?.agencies.value ?? []);
  const missingAgencies = expect.required_agencies.filter(
    (agency) => !agencies.has(agency),
  );

  /*
   * Verbatim preservation.
   *
   * Checked against the summary and the stated location, because those are
   * where a place name would be paraphrased away. "Shiv Mandir" becoming
   * "Shiva temple" is a silent loss of the most actionable string in the call.
   */
  const haystack = [
    extraction?.summary ?? "",
    JSON.stringify(extraction?.location.value ?? {}),
  ]
    .join(" ")
    .toLowerCase();

  const lostVerbatim = expect.must_preserve.filter(
    (needle) => !haystack.includes(needle.toLowerCase()),
  );

  return {
    case_id: testCase.id,
    tags: testCase.tags,
    extraction,
    type_correct: typeCorrect,
    type_actual: typeActual,
    priority,
    priority_actual: priorityActual,
    // Neither direction is an error where the case says both readings are
    // defensible.
    missed_life_threat:
      !expect.life_threat_ambiguous && expect.life_threat && !flaggedLifeThreat,
    false_life_threat:
      !expect.life_threat_ambiguous && !expect.life_threat && flaggedLifeThreat,
    missed_escalations: missedEscalations,
    required_escalations_count: expect.required_escalations.length,
    extra_escalations: extraEscalations,
    missing_agencies: missingAgencies,
    required_agencies_count: expect.required_agencies.length,
    lost_verbatim: lostVerbatim,
    required_verbatim_count: expect.must_preserve.length,
    degraded_fields: meta.degradedFields,
    problems: meta.problems,
    invented_evidence: countInventedEvidence(extraction, meta.validSegmentIds),
    latency_ms: meta.latencyMs,
    model_id: meta.modelId,
    error: meta.error,
  };
}

function countInventedEvidence(
  extraction: IncidentExtraction | null,
  validIds: Set<string>,
): number {
  if (!extraction) return 0;

  let invented = 0;
  for (const value of Object.values(extraction)) {
    if (
      typeof value !== "object" ||
      value === null ||
      !("evidence" in value) ||
      !Array.isArray((value as { evidence: unknown[] }).evidence)
    ) {
      continue;
    }
    for (const ref of (value as { evidence: string[] }).evidence) {
      if (!validIds.has(ref)) invented += 1;
    }
  }
  return invented;
}

/* ------------------------------------------------------------------ *
 * Aggregation
 * ------------------------------------------------------------------ */

export interface EvalSummary {
  model_id: string;
  cases: number;

  type_accuracy: number;
  priority_exact: number;

  /**
   * The headline safety numbers.
   *
   * Reported separately and first. A model with 95% overall accuracy that
   * missed two life threats is not a better model than one at 88% that missed
   * none, and a single blended score would say otherwise.
   */
  missed_life_threats: number;
  false_life_threats: number;
  under_triaged: number;
  over_triaged: number;
  /** Sum of weighted priority error. Lower is better; under-triage costs 3x. */
  weighted_priority_error: number;

  escalation_recall: number;
  /** Mean extra triggers per case. High values mean alert fatigue. */
  mean_extra_escalations: number;

  agency_recall: number;
  verbatim_preservation: number;

  degraded_field_rate: number;
  invented_evidence_total: number;
  failures: number;

  latency_p50: number;
  latency_p95: number;
  latency_p99: number;
  latency_max: number;
}

export function summarise(scores: CaseScore[], modelId: string): EvalSummary {
  const n = scores.length || 1;

  const requiredEscalations = sum(scores, (s) => s.required_escalations_count);
  const missedEscalations = sum(scores, (s) => s.missed_escalations.length);

  const requiredAgencies = sum(scores, (s) => s.required_agencies_count);
  const missingAgencies = sum(scores, (s) => s.missing_agencies.length);

  const requiredVerbatim = sum(scores, (s) => s.required_verbatim_count);
  const lostVerbatim = sum(scores, (s) => s.lost_verbatim.length);

  const latencies = scores.map((s) => s.latency_ms).filter((ms) => ms > 0);

  return {
    model_id: modelId,
    cases: scores.length,

    type_accuracy: scores.filter((s) => s.type_correct).length / n,
    priority_exact: scores.filter((s) => s.priority.distance === 0).length / n,

    missed_life_threats: scores.filter((s) => s.missed_life_threat).length,
    false_life_threats: scores.filter((s) => s.false_life_threat).length,
    under_triaged: scores.filter((s) => s.priority.under_triaged && s.priority.distance > 0)
      .length,
    over_triaged: scores.filter(
      (s) => !s.priority.under_triaged && s.priority.distance > 0,
    ).length,
    weighted_priority_error: scores.reduce((acc, s) => acc + s.priority.weighted, 0),

    escalation_recall:
      requiredEscalations === 0
        ? 1
        : (requiredEscalations - missedEscalations) / requiredEscalations,
    mean_extra_escalations:
      scores.reduce((acc, s) => acc + s.extra_escalations.length, 0) / n,

    agency_recall:
      requiredAgencies === 0 ? 1 : (requiredAgencies - missingAgencies) / requiredAgencies,
    verbatim_preservation:
      requiredVerbatim === 0 ? 1 : (requiredVerbatim - lostVerbatim) / requiredVerbatim,

    degraded_field_rate:
      scores.reduce((acc, s) => acc + s.degraded_fields.length, 0) / n,
    invented_evidence_total: scores.reduce((acc, s) => acc + s.invented_evidence, 0),
    failures: scores.filter((s) => s.error !== null).length,

    latency_p50: pct(latencies, 50),
    latency_p95: pct(latencies, 95),
    latency_p99: pct(latencies, 99),
    latency_max: latencies.length ? Math.max(...latencies) : 0,
  };
}

function sum(scores: CaseScore[], pick: (s: CaseScore) => number): number {
  return scores.reduce((acc, s) => acc + pick(s), 0);
}

function pct(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[index]!;
}
