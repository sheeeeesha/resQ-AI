import { z } from "zod";
import { Confidence } from "./field.js";
import { IncidentPriority, IncidentType } from "./enums.js";

/**
 * The fast triage pass.
 *
 * A live call cannot wait for the full extraction. Measured on 2026-08-31
 * against the same model and transcript:
 *
 *   full extraction (11 fields, nested objects)   12-20 s
 *   this grammar (4 fields, flat)                  2-4 s
 *
 * That difference is the entire reason this exists. On a call where a caller
 * is still speaking, a routing decision at three seconds and a complete record
 * at twenty is strictly better than one complete answer at twenty — the lane
 * and the priority are what a call-taker acts on first, and everything else
 * can arrive while they are already acting.
 *
 * Deliberately narrow. No location, no evidence, no people count. Every field
 * added here costs latency on the path where latency is the constraint, and
 * the full pass covers all of it a few seconds later.
 */
export const TriageExtraction = z.object({
  /** The dispatch lane. `unclear` is a valid and common early answer. */
  incident_type: z.union([IncidentType, z.literal("unclear")]),

  priority: z.union([IncidentPriority, z.literal("unclear")]),

  /**
   * Whether the caller has indicated an immediate threat to life.
   *
   * Separate from priority rather than derived from it. A model that hedges to
   * P1 while the caller is describing someone not breathing should still raise
   * this — and it is the flag that escalates, so it must not depend on the
   * model also having got the priority right.
   */
  life_threat: z.boolean(),

  /** Whether a person should take this call over immediately. */
  needs_human: z.boolean(),

  confidence: Confidence,
});
export type TriageExtraction = z.infer<typeof TriageExtraction>;

/**
 * Whether a triage result is settled enough to stop re-running the fast pass.
 *
 * Once the lane and priority are confident and stable, further fast passes buy
 * nothing — the full pass is what refines the record from there. This is what
 * stops a long call from paying for a triage call every few seconds until the
 * caller hangs up.
 */
export function triageIsSettled(
  triage: TriageExtraction | null,
  threshold = 0.8,
): boolean {
  if (!triage) return false;
  if (triage.incident_type === "unclear" || triage.priority === "unclear") {
    return false;
  }
  return triage.confidence >= threshold;
}
