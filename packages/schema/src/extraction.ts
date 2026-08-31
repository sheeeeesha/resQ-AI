import { z } from "zod";
import { Confidence, extractedField } from "./field.js";
import {
  CallerRole,
  EscalationTrigger,
  IncidentPriority,
  IncidentType,
  ResponseAgency,
  SceneHazard,
} from "./enums.js";

/**
 * The extraction contract — what the model is permitted to emit.
 *
 * This schema is compiled to JSON Schema and enforced by constrained decoding,
 * so the model physically cannot produce a malformed object. That replaces the
 * prototype's approach of prompting for JSON, stripping code fences and calling
 * JSON.parse inside a try/catch, which is reliable roughly 80-95% of the time
 * and degrades the entire record to "Unknown" on failure.
 *
 * Design constraints specific to constrained decoding:
 *
 *  - Kept deliberately flat. Deep nesting measurably degrades model quality
 *    under grammar constraints.
 *  - No coordinates. The model reports what was *said* about location;
 *    resolving that to a point is code's job, not the model's, and asking a
 *    language model for latitude is asking it to hallucinate.
 *  - Nothing derived. No response units, no timestamps, no IDs. If the system
 *    can compute it, the model must not guess it.
 */

/* ------------------------------------------------------------------ *
 * Value types
 * ------------------------------------------------------------------ */

/**
 * A count expressed as a range.
 *
 * Callers do not produce integers. They say "four or five people" and "a whole
 * family". Forcing that into a single number — as the prototype's
 * `approximate_casualties` did — invents precision that was never in the call.
 */
export const PeopleCount = z.object({
  min: z.number().int().nonnegative(),
  max: z.number().int().nonnegative(),
});
export type PeopleCount = z.infer<typeof PeopleCount>;

/**
 * Location exactly as described by the caller, decomposed but not resolved.
 *
 * Indian addressing is frequently relational rather than postal — "behind the
 * Shiv temple, near the old flyover, Sector 12". The landmark field is
 * therefore first-class, not a fallback: for a large share of calls it is the
 * most useful thing said, and flattening it into a single address string
 * throws away the part a local dispatcher can actually act on.
 */
export const StatedLocation = z.object({
  /** Full location phrase as spoken, in the original language. */
  raw: z.string(),
  /** Nearby landmark, if one was given. */
  landmark: z.string().nullable(),
  /** Locality, sector, colony, village or ward. */
  locality: z.string().nullable(),
  /** City, town or district. */
  city: z.string().nullable(),
  /** Any structured address component: house or plot number, road name. */
  street: z.string().nullable(),
  /** Plus Code or what3words address, if the caller read one out. */
  code: z.string().nullable(),
});
export type StatedLocation = z.infer<typeof StatedLocation>;

/* ------------------------------------------------------------------ *
 * Core extraction
 * ------------------------------------------------------------------ */

export const IncidentExtraction = z.object({
  /** What kind of emergency this is. */
  incident_type: extractedField(IncidentType),

  /** How fast a response is needed. Ordered scale; see enums.ts. */
  priority: extractedField(IncidentPriority),

  /**
   * Which ERSS lanes should receive this. An array because real incidents
   * cross lanes — a road traffic accident routinely needs health and police,
   * and sometimes fire for extrication.
   */
  agencies: extractedField(z.array(ResponseAgency).min(1).max(4)),

  /** Where it is, as described. Resolution to coordinates happens downstream. */
  location: extractedField(StatedLocation),

  /** How many people are affected, as a range. */
  people_affected: extractedField(PeopleCount),

  /** The caller's relationship to the incident. */
  caller_role: extractedField(CallerRole),

  /**
   * Hazards responders will meet on arrival. Empty array is a valid extracted
   * value and means "none mentioned"; that is distinct from status
   * `not_stated`, which means the topic never came up at all.
   */
  hazards: extractedField(z.array(SceneHazard).max(6)),

  /** Whether a minor is involved. Routes to the Children lane. */
  children_involved: extractedField(z.boolean()),

  /** Callback number, if the caller gave one distinct from the calling line. */
  callback_number: extractedField(z.string()),

  /**
   * One or two sentences a dispatcher can read at a glance. Always produced —
   * not wrapped in an envelope, because a summary of an unclear call is still
   * a useful summary, and "we could not summarise" is not an outcome the
   * console can use.
   */
  summary: z.string().max(400),

  /**
   * Conditions the model believes warrant a human taking over. The model may
   * raise these; it may never clear them. Escalation is one-way by design.
   */
  escalation_triggers: z.array(EscalationTrigger).max(6),

  /**
   * The model's own assessment of whether the transcript supported a
   * confident extraction at all. Separate from per-field confidence: a call
   * can have several individually confident fields and still be, overall, too
   * fragmentary to act on.
   */
  overall_confidence: Confidence,
});
export type IncidentExtraction = z.infer<typeof IncidentExtraction>;

/* ------------------------------------------------------------------ *
 * Medical supplement
 * ------------------------------------------------------------------ */

/**
 * Additional extraction for calls routed to the health lane.
 *
 * Runs as a second, narrower pass rather than being folded into the core
 * schema — it keeps the primary grammar small, and it only costs a call when
 * the health lane is actually indicated.
 *
 * The consciousness and breathing pair is the highest-value signal in
 * emergency medical dispatch. The reference deployment in this field (Corti,
 * Copenhagen) raised out-of-hospital cardiac arrest detection sensitivity from
 * 72.5% to 84.1% and cut median time-to-recognition from 54s to 44s by
 * attending to exactly this. Capturing it structurally is what makes that
 * class of result reachable later.
 */
export const MedicalSupplement = z.object({
  patient_conscious: extractedField(z.boolean()),
  patient_breathing: extractedField(z.boolean()),

  /**
   * Breathing described as abnormal — agonal, gasping, noisy, laboured.
   * Distinct from `patient_breathing: false`, and diagnostically important:
   * agonal breathing is routinely reported by callers as "breathing", which
   * is a known cause of missed cardiac arrest.
   */
  breathing_abnormal: extractedField(z.boolean()),

  /** Approximate age of the patient in years, where stated. */
  patient_age_years: extractedField(z.number().int().min(0).max(120)),

  /** Free text as described by the caller, not a coded diagnosis. */
  chief_complaint: extractedField(z.string().max(200)),

  /** Bleeding described as severe or uncontrolled. */
  severe_bleeding: extractedField(z.boolean()),

  /** Caller says the patient is pregnant. */
  pregnancy_involved: extractedField(z.boolean()),

  /**
   * True when the transcript contains indicators consistent with cardiac
   * arrest. Advisory only. This never dispatches on its own and never
   * suppresses a response — it raises a prompt for the call-taker, who
   * remains the decision-maker.
   */
  cardiac_arrest_indicators: extractedField(z.boolean()),
});
export type MedicalSupplement = z.infer<typeof MedicalSupplement>;

/* ------------------------------------------------------------------ *
 * Envelope
 * ------------------------------------------------------------------ */

/**
 * What one extraction pass returns, with the provenance needed to reproduce
 * it. Model identity and prompt version are recorded per pass because an
 * audit trail that cannot say which model produced a value is not an audit
 * trail — and because we will change models, and will need to know which
 * historical records came from which.
 */
export const ExtractionResult = z.object({
  incident_id: z.string().uuid(),

  /** Increments once per pass over the call. */
  pass: z.number().int().positive(),

  /** Highest segment index this pass considered. */
  through_segment_index: z.number().int().nonnegative(),

  core: IncidentExtraction,
  medical: MedicalSupplement.nullable(),

  model_id: z.string(),
  prompt_version: z.string(),
  latency_ms: z.number().int().nonnegative(),
  extracted_at: z.string().datetime(),
});
export type ExtractionResult = z.infer<typeof ExtractionResult>;

/* ------------------------------------------------------------------ *
 * Post-decode validation
 * ------------------------------------------------------------------ */

/**
 * Semantic checks that a decoding grammar cannot express.
 *
 * Constrained decoding guarantees shape, never sense. A model can emit a
 * perfectly-formed object claiming P0_immediate with 0.2 confidence and a
 * people count of max 3 / min 7. These are the checks that catch that.
 *
 * Returns problems rather than throwing: on a live call a partially usable
 * extraction beats no extraction, so callers decide what to discard.
 */
export function validateSemantics(core: IncidentExtraction): string[] {
  const problems: string[] = [];

  const people = core.people_affected;
  if (people.value && people.value.min > people.value.max) {
    problems.push("people_affected.min exceeds max");
  }

  // A top-priority classification asserted at low confidence is a contradiction
  // worth surfacing, not silently accepting.
  if (
    core.priority.value === "P0_immediate" &&
    core.priority.confidence < 0.5
  ) {
    problems.push("P0_immediate asserted at low confidence");
  }

  // Children involved must be reflected in routing.
  if (
    core.children_involved.value === true &&
    core.agencies.value &&
    !core.agencies.value.includes("children")
  ) {
    problems.push("children_involved is true but children lane not routed");
  }

  // A hazard was reported but no escalation raised.
  if (
    core.hazards.value &&
    core.hazards.value.length > 0 &&
    !core.escalation_triggers.includes("hazard_indicated")
  ) {
    problems.push("hazards present without hazard_indicated escalation");
  }

  // The model cited no evidence for a confident classification.
  if (
    core.incident_type.status === "extracted" &&
    core.incident_type.confidence > 0.8 &&
    core.incident_type.evidence.length === 0
  ) {
    problems.push("high-confidence incident_type cites no evidence");
  }

  return problems;
}
