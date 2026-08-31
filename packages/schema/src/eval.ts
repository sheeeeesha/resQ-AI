import { z } from "zod";
import {
  EscalationTrigger,
  IncidentPriority,
  IncidentType,
  ResponseAgency,
  SpokenLanguage,
} from "./enums.js";

/**
 * The evaluation contract.
 *
 * A labelled case and what "correct" means for it. Both need care, because the
 * obvious formulation of each is wrong for this domain.
 *
 * ## Why a single expected value is not enough
 *
 * A transcript saying "there's been an accident, someone is hurt" could
 * reasonably be classified `road_traffic_accident` or `medical_trauma`, and
 * scoring one as correct and the other as a failure would measure agreement
 * with whoever wrote the label rather than fitness for dispatch. So a case
 * carries an expected value *and* a set of acceptable alternatives.
 *
 * ## Why "unclear" has to be an expected answer
 *
 * A set where every case has a confident answer rewards a model that never
 * admits uncertainty — and that is precisely the behaviour this system is
 * built to prevent. Cases whose correct answer is `unclear` are not filler;
 * they are the ones that catch overconfidence.
 */

/** How wrong an answer is allowed to be before it counts as a failure. */
export const EvalExpectation = z.object({
  /** The label a trained call-taker would assign. */
  incident_type: z.union([IncidentType, z.literal("unclear")]),

  /**
   * Other classifications a competent operator might defensibly choose.
   *
   * Scored as correct. Without this the harness measures agreement with the
   * labeller, not fitness for dispatch.
   *
   * `unclear` belongs here as much as any concrete type does. On a vague
   * third-hand report both a considered guess and an admission of uncertainty
   * are defensible, and a set that accepted only one of them would be pushing
   * the system toward whichever the labeller happened to prefer.
   */
  acceptable_types: z.array(z.union([IncidentType, z.literal("unclear")])).default([]),

  priority: z.union([IncidentPriority, z.literal("unclear")]),
  acceptable_priorities: z
    .array(z.union([IncidentPriority, z.literal("unclear")]))
    .default([]),

  /** Lanes that must appear. Extra lanes are not penalised; missing ones are. */
  required_agencies: z.array(ResponseAgency).default([]),

  /**
   * Triggers that must fire.
   *
   * Recall on these is the number that matters most. Failing to escalate a
   * call that needed a human is the failure mode with real consequences, and
   * it is invisible in an overall accuracy figure.
   */
  required_escalations: z.array(EscalationTrigger).default([]),

  /**
   * True when a life threat is present.
   *
   * Tracked separately from priority because missing one is the single worst
   * outcome this system can produce, and it deserves its own number rather
   * than being averaged into a headline score.
   */
  life_threat: z.boolean().default(false),

  /**
   * True when either answer is defensible, so neither is scored as an error.
   *
   * The same principle as `acceptable_types`, applied to the one judgement
   * that carries the most weight. "A motorcycle and a car collided and the
   * rider is injured" is a real example: flagging a life threat and not
   * flagging one are both readings a trained call-taker might give, and
   * scoring one of them as a failure measures the labeller rather than the
   * system.
   *
   * Set this sparingly and never in response to a disagreement you did not
   * anticipate. An evaluation set edited whenever it delivers unwelcome news
   * stops being an evaluation, and this field is the easiest place in the
   * whole harness to do that accidentally.
   */
  life_threat_ambiguous: z.boolean().default(false),

  /** Substrings that must survive verbatim — place names, landmarks. */
  must_preserve: z.array(z.string()).default([]),

  /** True when the transcript genuinely does not support a location. */
  location_unresolvable: z.boolean().default(false),
});
export type EvalExpectation = z.infer<typeof EvalExpectation>;

/** One utterance in a case transcript. */
export const EvalUtterance = z.object({
  text: z.string(),
  speaker: z.enum(["caller", "call_taker"]).default("caller"),
  language: SpokenLanguage.default("mixed"),
  /** Null for text channels; a number simulates poor audio on voice cases. */
  asr_confidence: z.number().min(0).max(1).nullable().default(null),
});
export type EvalUtterance = z.infer<typeof EvalUtterance>;

export const EvalCase = z.object({
  id: z.string(),

  /**
   * What this case is testing.
   *
   * Required, and not documentation. A case whose purpose cannot be stated in
   * one line is usually testing nothing in particular, and a failing case is
   * only actionable if you know what it was for.
   */
  tests: z.string(),

  /** Grouping for per-category reporting: hinglish, negation, ambiguity… */
  tags: z.array(z.string()).default([]),

  channel: z.enum(["voice", "whatsapp", "sms", "web"]).default("whatsapp"),
  utterances: z.array(EvalUtterance).min(1),
  expect: EvalExpectation,
});
export type EvalCase = z.infer<typeof EvalCase>;

export const EvalSet = z.object({
  name: z.string(),
  version: z.string(),
  cases: z.array(EvalCase),
});
export type EvalSet = z.infer<typeof EvalSet>;

/* ------------------------------------------------------------------ *
 * Scoring
 * ------------------------------------------------------------------ */

/**
 * How severe a priority error is.
 *
 * Deliberately asymmetric. Under-triage sends a slower response to something
 * that needed a fast one; over-triage sends a fast response to something that
 * did not. Those are not the same mistake, and a symmetric confusion matrix
 * reports them as though they were — which is how a system that quietly
 * under-triages passes an evaluation.
 *
 * The multiplier is applied to the number of priority levels missed.
 */
export const UNDER_TRIAGE_WEIGHT = 3;
export const OVER_TRIAGE_WEIGHT = 1;

const PRIORITY_RANK: Record<string, number> = {
  P0_immediate: 0,
  P1_urgent: 1,
  P2_prompt: 2,
  P3_routine: 3,
  P4_referral: 4,
};

export interface PriorityError {
  /** Levels away from expected. 0 when correct. */
  distance: number;
  /** True when the system was less urgent than it should have been. */
  under_triaged: boolean;
  /** Distance times the appropriate weight. */
  weighted: number;
}

export function scorePriority(
  expected: string,
  actual: string | null,
): PriorityError {
  const expectedRank = PRIORITY_RANK[expected];
  const actualRank = actual === null ? undefined : PRIORITY_RANK[actual];

  // No answer is treated as maximal under-triage. A system that declines to
  // classify a P0 has failed in the same direction as one that calls it P4,
  // and scoring it as merely "missing" would let silence look safe.
  if (expectedRank === undefined) return { distance: 0, under_triaged: false, weighted: 0 };
  if (actualRank === undefined) {
    const distance = 4 - expectedRank;
    return {
      distance,
      under_triaged: true,
      weighted: distance * UNDER_TRIAGE_WEIGHT,
    };
  }

  const distance = Math.abs(actualRank - expectedRank);
  const underTriaged = actualRank > expectedRank;

  return {
    distance,
    under_triaged: underTriaged,
    weighted: distance * (underTriaged ? UNDER_TRIAGE_WEIGHT : OVER_TRIAGE_WEIGHT),
  };
}

/** Percentile from a set of samples. Used for latency, where the tail matters. */
export function percentile(samples: number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
  );
  return sorted[index]!;
}
