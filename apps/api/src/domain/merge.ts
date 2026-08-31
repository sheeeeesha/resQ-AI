import type { IncidentExtraction } from "@resqai/schema";
import { asProposal, type ExtractedField, type ReviewedField } from "@resqai/schema";
import { REVIEWABLE_FIELDS, type ReviewableField } from "../repository/incidents.js";

/**
 * Merging an extraction into an incident.
 *
 * One rule dominates everything else here:
 *
 *   **A human decision is never overwritten by a model.**
 *
 * Extraction runs repeatedly as a contact develops. Between passes, a
 * call-taker may have confirmed or corrected a field. If a later pass could
 * overwrite that, the console would silently undo the operator's work — they
 * would set the priority, look away, and find it changed back. In a dispatch
 * system that is not a synchronisation bug, it is a safety failure, and it is
 * the kind that only shows up under exactly the conditions where it matters.
 *
 * So: fields still in `ai_proposed` state are updated freely. Anything a person
 * has touched is left exactly as they left it, and the model's competing value
 * is recorded as a suggestion rather than applied.
 */

export interface MergeResult {
  /** The field envelopes to persist. */
  fields: Record<string, ReviewedField<unknown>>;
  /** Fields updated by this pass. */
  updated: ReviewableField[];
  /** Fields left alone because a human owns them. */
  preserved: ReviewableField[];
  /**
   * Fields where the model now disagrees with a human decision. Surfaced in
   * the console as a suggestion; never applied automatically.
   */
  contested: Array<{
    field: ReviewableField;
    humanValue: unknown;
    modelValue: unknown;
    modelConfidence: number;
  }>;
}

/** Whether a stored field is still owned by the model. */
function isUnreviewed(field: ReviewedField<unknown> | undefined): boolean {
  return field?.review?.state === "ai_proposed";
}

export function mergeExtraction(
  current: Record<string, unknown>,
  extraction: IncidentExtraction,
): MergeResult {
  const fields: Record<string, ReviewedField<unknown>> = {};
  const updated: ReviewableField[] = [];
  const preserved: ReviewableField[] = [];
  const contested: MergeResult["contested"] = [];

  for (const name of REVIEWABLE_FIELDS) {
    const existing = current[name] as ReviewedField<unknown> | undefined;
    const incoming = extraction[name] as ExtractedField<unknown> | undefined;

    // The extraction contract and the reviewable set can legitimately diverge
    // — a field may exist on the incident that no pass produces. Keep what is
    // stored rather than dropping it.
    if (!incoming) {
      if (existing) fields[name] = existing;
      continue;
    }

    if (!existing || isUnreviewed(existing)) {
      fields[name] = asProposal(incoming);
      updated.push(name);
      continue;
    }

    // A human owns this field. It stays as they left it.
    fields[name] = existing;
    preserved.push(name);

    if (
      incoming.status === "extracted" &&
      !valuesAgree(existing.value, incoming.value)
    ) {
      contested.push({
        field: name,
        humanValue: existing.value,
        modelValue: incoming.value,
        modelConfidence: incoming.confidence,
      });
    }
  }

  return { fields, updated, preserved, contested };
}

/**
 * Structural equality, order-insensitive for arrays.
 *
 * `agencies` and `hazards` are sets in meaning even though they are arrays in
 * transport, so `["health","police"]` and `["police","health"]` are the same
 * decision. Treating them as different would raise a contested-field warning
 * on every pass and train operators to ignore the signal.
 */
function valuesAgree(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    const sortedA = [...a].map((v) => JSON.stringify(v)).sort();
    const sortedB = [...b].map((v) => JSON.stringify(v)).sort();
    return sortedA.every((v, i) => v === sortedB[i]);
  }

  if (typeof a === "object" && typeof b === "object") {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  return false;
}

/**
 * Whether a later pass should replace the stored summary.
 *
 * Summaries are regenerated wholesale rather than merged, but an empty summary
 * from a degraded pass must not wipe a good one from an earlier pass.
 */
export function chooseSummary(current: string, incoming: string): string {
  if (!incoming.trim()) return current;
  return incoming;
}
