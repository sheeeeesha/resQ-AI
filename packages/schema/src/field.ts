import { z } from "zod";
import {
  ConfirmationState,
  FieldStatus,
  OverrideReason,
} from "./enums.js";

/**
 * The field envelope.
 *
 * Every AI-derived value in ResQAI is wrapped rather than stored bare. This is
 * the single most important structural decision in the schema, and it exists
 * because of one number: Indic ASR runs at roughly 22-30% word error rate on
 * telephony audio, and around 42% on code-switched speech. A pipeline built on
 * text that wrong cannot emit bare values and stay honest.
 *
 * The envelope forces four questions to be answered explicitly for every field:
 *
 *   value      — what we think it is (nullable; null is a legitimate answer)
 *   status     — whether the caller stated it, didn't, or was unintelligible
 *   confidence — how sure the model is
 *   evidence   — which transcript segments support it
 *
 * The prototype answered none of these. It emitted `location: "Unknown"` on
 * failure, which is indistinguishable in the database from a caller who
 * genuinely said "unknown", and renders in the UI as though it were a fact.
 */

/** Model confidence, 0-1. */
export const Confidence = z.number().min(0).max(1);

/**
 * Reference to a transcript segment, e.g. "s14".
 *
 * The transcript is fed to the extractor as numbered segments so the model can
 * cite its sources. Every extracted value is therefore traceable back to the
 * audio it came from — which is what makes per-field provenance possible, and
 * what a reviewer needs when asking why the system said what it said.
 */
export const SegmentRef = z.string().regex(/^s\d+$/, 'Expected a segment ref like "s12"');
export type SegmentRef = z.infer<typeof SegmentRef>;

/**
 * Wraps a value schema in the extraction envelope.
 *
 * Kept as a plain object schema with no refinements attached, deliberately.
 * Refinements do not survive conversion to JSON Schema, so a schema carrying
 * them would validate differently from the grammar the model is decoded
 * against — two subtly different contracts under one name.
 *
 * The split we want instead:
 *
 *   - JSON Schema constrains the *shape* during constrained decoding, so the
 *     model physically cannot emit a malformed object.
 *   - `checkFieldInvariants` catches *semantic* violations after decoding,
 *     where we can log and recover rather than silently accept.
 *
 * Pushing semantics into the decoding grammar makes the grammar large and the
 * model worse. Keep the grammar simple; validate after.
 */
export function extractedField<T extends z.ZodTypeAny>(value: T) {
  return z.object({
    value: value.nullable(),
    status: FieldStatus,
    confidence: Confidence,
    evidence: z.array(SegmentRef).max(4),
  });
}

/**
 * The value/status invariant, checked post-decode.
 *
 * `status: "extracted"` must carry a value, and any non-null value must be
 * marked extracted. A model that emits `{ value: null, status: "extracted" }`
 * is telling us something went wrong in decoding, and we want that logged
 * rather than stored as though the caller had said nothing.
 */
export function checkFieldInvariants<T>(
  name: string,
  f: ExtractedField<T>,
): string[] {
  const problems: string[] = [];
  if (f.status === "extracted" && f.value === null) {
    problems.push(`${name}: status "extracted" with null value`);
  }
  if (f.status !== "extracted" && f.value !== null) {
    problems.push(`${name}: non-null value with status "${f.status}"`);
  }
  return problems;
}

/** Shape of an extraction envelope, independent of the value type. */
export type ExtractedField<T> = {
  value: T | null;
  status: FieldStatus;
  confidence: number;
  evidence: SegmentRef[];
};

/* ------------------------------------------------------------------ *
 * Review envelope
 * ------------------------------------------------------------------ */

/**
 * Record of a human acting on an AI-proposed value.
 *
 * Stored per field rather than per incident. Aggregated across incidents, the
 * override rate broken down by field and reason is the system's primary
 * quality metric — the one figure that demonstrates the product is honest
 * about its own limits. It is not obtainable retrospectively; it has to be
 * captured at the moment of the override, which is why it lives in the schema
 * rather than in an analytics afterthought.
 */
export const ReviewRecord = z.object({
  state: ConfirmationState,
  reviewed_by: z.string().nullable().default(null),
  reviewed_at: z.string().datetime().nullable().default(null),
  /** Set only when the human changed the value. */
  override_reason: OverrideReason.nullable().default(null),
  /** The AI's value at the moment of override, retained for audit. */
  superseded_value: z.unknown().nullable().default(null),
});
export type ReviewRecord = z.infer<typeof ReviewRecord>;

/**
 * An extraction envelope plus its review state. This is the stored form;
 * `extractedField` is the wire form the model produces.
 */
export function reviewedField<T extends z.ZodTypeAny>(value: T) {
  return z.object({
    value: value.nullable(),
    status: FieldStatus,
    confidence: Confidence,
    evidence: z.array(SegmentRef).max(4).default([]),
    review: ReviewRecord,
  });
}

export type ReviewedField<T> = ExtractedField<T> & { review: ReviewRecord };

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/**
 * Confidence below which a field must not be presented to a call-taker as
 * fact. Fields under this threshold render as "unconfirmed — ask again"
 * rather than as a value.
 *
 * Set conservatively and deliberately: on a 25% WER transcript, a model that
 * reports 0.7 confidence is frequently wrong. Tune against measured data once
 * we have it, not against intuition.
 */
export const DISPLAY_CONFIDENCE_THRESHOLD = 0.75;

/**
 * Confidence below which a field may not be used for automated routing at
 * all — dispatch decisions require either higher confidence or a human.
 */
export const ROUTING_CONFIDENCE_THRESHOLD = 0.85;

/** True when a value is safe to show as a fact rather than a prompt. */
export function isDisplayable<T>(f: ExtractedField<T>): boolean {
  return f.status === "extracted" && f.confidence >= DISPLAY_CONFIDENCE_THRESHOLD;
}

/** True when a value may feed automated routing without human confirmation. */
export function isRoutable<T>(f: ExtractedField<T>): boolean {
  return f.status === "extracted" && f.confidence >= ROUTING_CONFIDENCE_THRESHOLD;
}

/** True when the call-taker should be prompted to ask about this field. */
export function needsFollowUp<T>(f: ExtractedField<T>): boolean {
  return f.status !== "extracted" || f.confidence < DISPLAY_CONFIDENCE_THRESHOLD;
}

/** Lifts a wire-form extraction into stored form as an unreviewed proposal. */
export function asProposal<T>(f: ExtractedField<T>): ReviewedField<T> {
  return {
    ...f,
    review: {
      state: "ai_proposed",
      reviewed_by: null,
      reviewed_at: null,
      override_reason: null,
      superseded_value: null,
    },
  };
}

/** An empty, never-stated field. Used to initialise a fresh incident. */
export function emptyField<T>(): ReviewedField<T> {
  return asProposal<T>({
    value: null,
    status: "not_stated",
    confidence: 0,
    evidence: [],
  });
}
