import { z } from "zod";

/**
 * Closed vocabularies for ResQAI.
 *
 * Every enum here is a *contract*. Two rules hold throughout:
 *
 *  1. Nothing free-text. The prototype let the model emit arbitrary strings for
 *     criticality and emergency type; that made records unsortable, unauditable
 *     and un-mappable to a real response.
 *  2. "Unknown" is always representable. A model that cannot say "I don't know"
 *     will guess, and a guess that looks like an answer is the most dangerous
 *     output this system can produce.
 */

/* ------------------------------------------------------------------ *
 * Routing
 * ------------------------------------------------------------------ */

/**
 * ERSS-112 dispatch agencies. This is not our taxonomy — it mirrors the
 * downstream dispatcher lanes the state PSAP already routes to, so our output
 * lands in a shape the operator's existing workflow understands.
 */
export const ResponseAgency = z.enum([
  "police",
  "health",
  "fire",
  "disaster",
  "women",
  "children",
  "railways",
]);
export type ResponseAgency = z.infer<typeof ResponseAgency>;

/* ------------------------------------------------------------------ *
 * Priority
 * ------------------------------------------------------------------ */

/**
 * Ordered response priority.
 *
 * Deliberately NOT MPDS/ProQA determinant codes: those are a licensed
 * commercial product (Priority Dispatch Corp) and are not the operating
 * standard in India. This is an independent, five-level ordered scale that
 * maps to a dispatch decision the same way determinant levels do.
 *
 * Encoded as `P0`..`P4` so lexicographic sort and semantic severity agree.
 * The prototype's "High"/"Medium"/"Low" sorted to Medium > Low > High under
 * Firestore's descending string order, putting the most critical incidents
 * last. An ordered code makes that class of bug unrepresentable.
 */
export const IncidentPriority = z.enum([
  "P0_immediate", // Life-threatening now. Dispatch before the call ends.
  "P1_urgent", // Serious; rapid dispatch required.
  "P2_prompt", // Response needed, not immediately life-threatening.
  "P3_routine", // Non-urgent response.
  "P4_referral", // Not an emergency; advise or refer onward.
]);
export type IncidentPriority = z.infer<typeof IncidentPriority>;

/** Numeric rank for sorting and comparison. Lower is more urgent. */
export const PRIORITY_RANK: Record<IncidentPriority, number> = {
  P0_immediate: 0,
  P1_urgent: 1,
  P2_prompt: 2,
  P3_routine: 3,
  P4_referral: 4,
};

/* ------------------------------------------------------------------ *
 * Incident classification
 * ------------------------------------------------------------------ */

/**
 * Incident types, grouped by the agency lane they most often route to.
 * Kept to a single flat enum rather than a nested discriminated union:
 * constrained decoding degrades on deep nesting, and a flat closed set is
 * what the model handles most reliably.
 *
 * The list is weighted toward call types that actually dominate Indian
 * emergency traffic — road traffic accidents, drowning, electrocution,
 * animal attack — rather than a generic Western dispatch taxonomy.
 */
export const IncidentType = z.enum([
  // Medical
  "medical_cardiac",
  "medical_breathing",
  "medical_unconscious",
  "medical_trauma",
  "medical_obstetric",
  "medical_poisoning",
  "medical_burns",
  "medical_seizure",
  "medical_psychiatric",
  "medical_other",

  // Road and transport
  "road_traffic_accident",
  "rail_incident",

  // Fire
  "fire_structure",
  "fire_vehicle",
  "fire_outdoor",
  "fire_other",

  // Crime and public order
  "crime_assault",
  "crime_theft_robbery",
  "crime_kidnapping",
  "crime_sexual_offence",
  "crime_domestic_violence",
  "crime_missing_person",
  "crime_other",
  "public_disturbance",

  // Environmental and disaster
  "disaster_flood",
  "disaster_earthquake",
  "disaster_landslide",
  "structural_collapse",
  "disaster_other",

  // Other high-frequency Indian call types
  "drowning",
  "electrocution",
  "animal_attack",
  "gas_leak",
  "rescue_trapped",

  // Terminal fallbacks
  "other",
  "unknown",
]);
export type IncidentType = z.infer<typeof IncidentType>;

/**
 * Default agency routing per incident type. Advisory only — the classifier may
 * propose additional agencies (a road traffic accident often needs health and
 * police and occasionally fire), and a human may always override.
 */
export const DEFAULT_AGENCY: Record<IncidentType, ResponseAgency> = {
  medical_cardiac: "health",
  medical_breathing: "health",
  medical_unconscious: "health",
  medical_trauma: "health",
  medical_obstetric: "health",
  medical_poisoning: "health",
  medical_burns: "health",
  medical_seizure: "health",
  medical_psychiatric: "health",
  medical_other: "health",
  road_traffic_accident: "police",
  rail_incident: "railways",
  fire_structure: "fire",
  fire_vehicle: "fire",
  fire_outdoor: "fire",
  fire_other: "fire",
  crime_assault: "police",
  crime_theft_robbery: "police",
  crime_kidnapping: "police",
  crime_sexual_offence: "women",
  crime_domestic_violence: "women",
  crime_missing_person: "police",
  crime_other: "police",
  public_disturbance: "police",
  disaster_flood: "disaster",
  disaster_earthquake: "disaster",
  disaster_landslide: "disaster",
  structural_collapse: "disaster",
  disaster_other: "disaster",
  drowning: "disaster",
  electrocution: "health",
  animal_attack: "health",
  gas_leak: "fire",
  rescue_trapped: "fire",
  other: "police",
  unknown: "police",
};

/* ------------------------------------------------------------------ *
 * Responder safety
 * ------------------------------------------------------------------ */

/**
 * Hazards present at scene. Surfaced separately from incident type because
 * these change how responders approach, not what they are responding to.
 * Missing one of these is how responders get hurt.
 */
export const SceneHazard = z.enum([
  "weapon_present",
  "fire_spreading",
  "gas_or_chemical",
  "electrical_live",
  "structural_unstable",
  "deep_or_fast_water",
  "crowd_hostile",
  "ongoing_traffic",
  "confined_space",
  "assailant_present",
]);
export type SceneHazard = z.infer<typeof SceneHazard>;

/* ------------------------------------------------------------------ *
 * Caller
 * ------------------------------------------------------------------ */

/**
 * Caller's relationship to the incident.
 *
 * Operationally significant, not demographic colour: a caller who is a victim
 * or is otherwise personally involved is one of the standard triggers for
 * escalating a call to a human immediately.
 */
export const CallerRole = z.enum([
  "victim",
  "bystander",
  "family_or_friend",
  "official_or_responder",
  "third_party_reporting",
  "unknown",
]);
export type CallerRole = z.infer<typeof CallerRole>;

/* ------------------------------------------------------------------ *
 * Intake
 * ------------------------------------------------------------------ */

/**
 * Intake channels, mirroring the ten ERSS-112 accepts.
 *
 * Text channels matter disproportionately: they carry no ASR error at all, so
 * extraction accuracy on them is far higher than on voice. They are also the
 * accessible path for deaf and hard-of-hearing callers.
 */
export const IntakeChannel = z.enum([
  "voice",
  "sms",
  "whatsapp",
  "web",
  "chatbot",
  "email",
  "sos_button",
  "iot_signal",
  "external_signal",
]);
export type IntakeChannel = z.infer<typeof IntakeChannel>;

/** True where the channel carries text directly and no ASR stage applies. */
export const IS_TEXT_CHANNEL: Record<IntakeChannel, boolean> = {
  voice: false,
  sms: true,
  whatsapp: true,
  web: true,
  chatbot: true,
  email: true,
  sos_button: false,
  iot_signal: false,
  external_signal: false,
};

/* ------------------------------------------------------------------ *
 * Language
 * ------------------------------------------------------------------ */

/**
 * The 22 scheduled languages plus English, as ISO 639-1 where one exists and
 * ISO 639-3 otherwise.
 *
 * `mixed` is a first-class value, not a failure. Code-switching is the default
 * register in Indian emergency calls, and a pipeline that has to pick a single
 * language label for a Hinglish call will mislabel most of its traffic.
 */
export const SpokenLanguage = z.enum([
  "en", // English
  "hi", // Hindi
  "bn", // Bengali
  "mr", // Marathi
  "te", // Telugu
  "ta", // Tamil
  "gu", // Gujarati
  "ur", // Urdu
  "kn", // Kannada
  "or", // Odia
  "ml", // Malayalam
  "pa", // Punjabi
  "as", // Assamese
  "mai", // Maithili
  "sat", // Santali
  "ks", // Kashmiri
  "ne", // Nepali
  "sd", // Sindhi
  "kok", // Konkani
  "doi", // Dogri
  "mni", // Manipuri
  "brx", // Bodo
  "sa", // Sanskrit
  "mixed", // Code-switched across two or more of the above
  "unknown",
]);
export type SpokenLanguage = z.infer<typeof SpokenLanguage>;

/* ------------------------------------------------------------------ *
 * Location
 * ------------------------------------------------------------------ */

/**
 * How a location candidate was obtained, ordered by trustworthiness.
 *
 * Device-derived location never passes through the transcript, so it never
 * inherits ASR error. Anything `stated_*` does, and must be treated as weaker
 * evidence — the inverse of the prototype, which trusted only the transcript.
 */
export const LocationSource = z.enum([
  "device_els", // Android Emergency Location Service / iOS AML
  "device_gps", // App-reported handset GPS
  "network_cell", // Cell-tower / LBS triangulation
  "plus_code", // Google Plus Code spoken by caller
  "what3words", // Three-word address spoken by caller
  "stated_address", // Street address spoken by caller
  "stated_landmark", // "Behind the Shiv temple, near the flyover"
  "caller_registered", // Address on file for this number
  "inferred", // Derived from other signals; weakest
]);
export type LocationSource = z.infer<typeof LocationSource>;

/** Descending trust order. Used to rank competing location candidates. */
export const LOCATION_SOURCE_TRUST: Record<LocationSource, number> = {
  device_els: 100,
  device_gps: 90,
  what3words: 80,
  plus_code: 78,
  network_cell: 60,
  stated_address: 50,
  stated_landmark: 35,
  caller_registered: 30,
  inferred: 10,
};

/* ------------------------------------------------------------------ *
 * Field-level state
 * ------------------------------------------------------------------ */

/**
 * Why a field holds the value it holds.
 *
 * The distinction that matters: `not_stated` means the caller never said it,
 * `unclear` means something was said but could not be resolved — often because
 * ASR confidence on that span was too low. Collapsing these two into a null,
 * as the prototype did with its "Unknown" fallback, destroys the only signal
 * that tells a call-taker whether to ask the question again.
 */
export const FieldStatus = z.enum([
  "extracted", // Stated and understood.
  "not_stated", // Caller has not provided this.
  "unclear", // Mentioned but not resolvable at acceptable confidence.
]);
export type FieldStatus = z.infer<typeof FieldStatus>;

/**
 * Human review state for a field. Every AI-derived value enters as
 * `ai_proposed` and stays a proposal until a person acts on it.
 */
export const ConfirmationState = z.enum([
  "ai_proposed",
  "human_confirmed",
  "human_corrected",
  "human_entered",
]);
export type ConfirmationState = z.infer<typeof ConfirmationState>;

/* ------------------------------------------------------------------ *
 * Incident lifecycle
 * ------------------------------------------------------------------ */

export const IncidentStatus = z.enum([
  "active_call", // Call in progress; fields still updating.
  "awaiting_confirmation", // Call ended or handed over; needs human sign-off.
  "dispatched", // Handed to an agency dispatcher.
  "on_scene",
  "resolved",
  "cancelled", // Withdrawn, hoax, or test.
  "merged_duplicate", // Folded into another incident.
]);
export type IncidentStatus = z.infer<typeof IncidentStatus>;

/**
 * Why a call-taker changed an AI-proposed value. Recorded rather than
 * optional: override *reasons*, aggregated, are what turn the override rate
 * into a diagnostic instead of a bare number.
 */
export const OverrideReason = z.enum([
  "misheard_audio",
  "wrong_classification",
  "wrong_location",
  "wrong_severity",
  "missing_context",
  "caller_corrected_themselves",
  "local_knowledge",
  "other",
]);
export type OverrideReason = z.infer<typeof OverrideReason>;

/**
 * Triggers that force a call out of assisted handling and onto a human.
 * Modelled on the escalation rules the live US deployments operate under.
 */
export const EscalationTrigger = z.enum([
  "low_confidence",
  "caller_is_involved",
  "life_threat_indicated",
  "hazard_indicated",
  "child_involved",
  "language_unsupported",
  "asr_quality_poor",
  "contradictory_information",
  "silence_or_no_response",
  "caller_requested_human",
  "system_degraded",
]);
export type EscalationTrigger = z.infer<typeof EscalationTrigger>;
