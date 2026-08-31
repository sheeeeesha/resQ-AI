import { z } from "zod";
import { Confidence, SegmentRef } from "./field.js";
import { IntakeChannel, SpokenLanguage } from "./enums.js";

/**
 * Transcript model.
 *
 * Two things distinguish this from the prototype's `{ message, speaker,
 * timestamp }` triple:
 *
 *  1. ASR confidence is carried per segment and never discarded. It is the
 *     input to almost every safety decision downstream — whether to show a
 *     field as fact, whether to escalate, whether to ask again.
 *
 *  2. The original utterance is preserved alongside any translation. On
 *     code-switched Indian speech this is not optional: models that translate
 *     rather than transcribe destroy the phonetic content that place names and
 *     proper nouns depend on, and a translated-only record cannot be re-checked.
 */

/* ------------------------------------------------------------------ *
 * Speakers
 * ------------------------------------------------------------------ */

/**
 * Normalised speaker roles.
 *
 * Deliberately explicit because upstream vendors disagree: telephony and voice
 * platforms commonly emit `user`/`assistant`, while the prototype's emotion
 * detection filtered on the literal string `"caller"` and would have silently
 * matched nothing against a `user`/`assistant` feed — returning Neutral for
 * every call while appearing to work.
 *
 * Adapters MUST map into this enum at the ingest boundary. Never filter on a
 * vendor's raw label anywhere downstream.
 */
export const SpeakerRole = z.enum([
  "caller",
  "call_taker", // Human operator.
  "ai_agent", // Automated voice agent, where one is in the loop.
  "third_party", // Audible bystander, patient, or transferred party.
  "unknown",
]);
export type SpeakerRole = z.infer<typeof SpeakerRole>;

/* ------------------------------------------------------------------ *
 * Segments
 * ------------------------------------------------------------------ */

export const TranscriptSegment = z.object({
  /** Stable ref, e.g. "s12". Cited by extracted fields as evidence. */
  id: SegmentRef,

  /** Monotonic index within the transcript, from 0. */
  index: z.number().int().nonnegative(),

  speaker: SpeakerRole,

  /**
   * The utterance as spoken, in its original language and script. For
   * code-switched speech this stays mixed — it is not normalised to one
   * language, because doing so is lossy and usually wrong.
   */
  text: z.string(),

  /**
   * English rendering, where the original is not already English.
   * Null when no translation was performed or none was needed.
   */
  text_en: z.string().nullable().default(null),

  /** Dominant language of this segment; `mixed` for code-switched utterances. */
  language: SpokenLanguage,

  /**
   * ASR confidence for this segment, 0-1. Null for text channels, where the
   * text is exact and no recognition step occurred.
   */
  asr_confidence: Confidence.nullable(),

  /** Milliseconds from call start. Null for asynchronous text channels. */
  start_ms: z.number().int().nonnegative().nullable().default(null),
  end_ms: z.number().int().nonnegative().nullable().default(null),

  /** Wall-clock time this segment was received. */
  received_at: z.string().datetime(),

  /**
   * True when this segment revised an earlier partial result. Streaming ASR
   * emits provisional text that is later corrected; extraction must run
   * against settled text, not provisional text.
   */
  is_final: z.boolean().default(true),
});
export type TranscriptSegment = z.infer<typeof TranscriptSegment>;

/* ------------------------------------------------------------------ *
 * Quality rollup
 * ------------------------------------------------------------------ */

/**
 * Aggregate signal quality for the call so far.
 *
 * Computed, not stored as truth — but materialised on the incident so the
 * console can show a call-taker *why* the assistant is being cautious, and so
 * poor audio becomes a visible condition rather than a mysterious absence of
 * extracted fields.
 */
export const TranscriptQuality = z.object({
  /** Mean ASR confidence across final caller segments. Null on text channels. */
  mean_asr_confidence: Confidence.nullable(),

  /** Share of caller segments below the usable threshold, 0-1. */
  low_confidence_ratio: z.number().min(0).max(1),

  /** Distinct languages observed. Length > 1 indicates code-switching. */
  languages_detected: z.array(SpokenLanguage).default([]),

  /** True when audio quality alone justifies routing to a human. */
  degraded: z.boolean(),

  segment_count: z.number().int().nonnegative(),
});
export type TranscriptQuality = z.infer<typeof TranscriptQuality>;

/** Below this mean confidence, the transcript is treated as degraded. */
export const DEGRADED_ASR_THRESHOLD = 0.65;

export function assessQuality(segments: TranscriptSegment[]): TranscriptQuality {
  const caller = segments.filter((s) => s.speaker === "caller" && s.is_final);
  const scored = caller.filter(
    (s): s is TranscriptSegment & { asr_confidence: number } =>
      s.asr_confidence !== null,
  );

  const mean =
    scored.length > 0
      ? scored.reduce((acc, s) => acc + s.asr_confidence, 0) / scored.length
      : null;

  const lowRatio =
    scored.length > 0
      ? scored.filter((s) => s.asr_confidence < DEGRADED_ASR_THRESHOLD).length /
        scored.length
      : 0;

  const languages = [...new Set(caller.map((s) => s.language))];

  return {
    mean_asr_confidence: mean,
    low_confidence_ratio: lowRatio,
    languages_detected: languages,
    // A text channel has no ASR and is never degraded on these grounds.
    degraded: mean !== null && mean < DEGRADED_ASR_THRESHOLD,
    segment_count: caller.length,
  };
}

/* ------------------------------------------------------------------ *
 * Transcript
 * ------------------------------------------------------------------ */

export const Transcript = z.object({
  incident_id: z.string().uuid(),
  channel: IntakeChannel,
  segments: z.array(TranscriptSegment).default([]),
  quality: TranscriptQuality,
  /** ASR engine and version, for reproducing and auditing a given extraction. */
  asr_engine: z.string().nullable().default(null),
  started_at: z.string().datetime(),
  ended_at: z.string().datetime().nullable().default(null),
});
export type Transcript = z.infer<typeof Transcript>;

/* ------------------------------------------------------------------ *
 * Extractor input
 * ------------------------------------------------------------------ */

/**
 * Renders segments for the extraction prompt.
 *
 * Segment refs are emitted inline so the model can cite them as evidence, and
 * low-confidence spans are marked so the model can down-weight them rather
 * than treating every word as equally reliable. Telling the model where the
 * audio was bad is the cheapest accuracy improvement available on this path.
 */
export function renderForExtraction(segments: TranscriptSegment[]): string {
  return segments
    .filter((s) => s.is_final)
    .map((s) => {
      const shaky =
        s.asr_confidence !== null && s.asr_confidence < DEGRADED_ASR_THRESHOLD
          ? " [low-confidence audio]"
          : "";
      const translated =
        s.text_en && s.text_en !== s.text ? ` (en: ${s.text_en})` : "";
      return `[${s.id}] ${s.speaker}${shaky}: ${s.text}${translated}`;
    })
    .join("\n");
}
