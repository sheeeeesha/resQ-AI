import { z } from "zod";
import {
  CallerRole,
  EscalationTrigger,
  IncidentPriority,
  IncidentStatus,
  IncidentType,
  IntakeChannel,
  LocationSource,
  LOCATION_SOURCE_TRUST,
  ResponseAgency,
  SceneHazard,
  SpokenLanguage,
} from "./enums.js";
import { Confidence, reviewedField } from "./field.js";
import { PeopleCount, StatedLocation } from "./extraction.js";
import { TranscriptQuality } from "./transcript.js";

/**
 * The stored incident record.
 *
 * Distinct from `IncidentExtraction`, which is the wire form the model emits.
 * This is the assembled truth: model proposals plus human review state plus
 * everything the system resolved on its own.
 */

/* ------------------------------------------------------------------ *
 * Location
 * ------------------------------------------------------------------ */

export const GeoPoint = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});
export type GeoPoint = z.infer<typeof GeoPoint>;

/**
 * One possible location for the incident.
 *
 * Plural by design. The prototype geocoded a single model-produced address
 * string and silently took `results[0]`, which on an ambiguous Indian address
 * is a coin flip presented as a fact. Here every candidate survives with its
 * provenance attached, and an unresolved location stays visibly unresolved.
 */
export const LocationCandidate = z.object({
  source: LocationSource,
  point: GeoPoint,

  /** Radius of uncertainty in metres. Android ELS typically lands near 50 m. */
  accuracy_m: z.number().nonnegative().nullable().default(null),

  /** Human-readable label for the console. */
  label: z.string(),

  /** Trust score from LOCATION_SOURCE_TRUST, carried for stable ranking. */
  trust: z.number().int(),

  /** When this candidate was obtained. Device fixes go stale. */
  obtained_at: z.string().datetime(),
});
export type LocationCandidate = z.infer<typeof LocationCandidate>;

export const ResolvedLocation = z.object({
  /** All candidates, ranked by trust descending. Never truncated to one. */
  candidates: z.array(LocationCandidate).default([]),

  /**
   * Index into `candidates` of the location in use.
   * Null means unresolved — the console must show the ambiguity rather than
   * pick for the operator.
   */
  selected_index: z.number().int().nonnegative().nullable().default(null),

  /** Whether a human chose the selected candidate. */
  selected_by_human: z.boolean().default(false),

  /** What the caller actually said, retained verbatim. */
  stated: StatedLocation.nullable().default(null),
});
export type ResolvedLocation = z.infer<typeof ResolvedLocation>;

/**
 * Ranks candidates by trust, then by recency.
 *
 * Uses each candidate's own `trust` value rather than looking the score up
 * from its source. The two are usually the same, but not always, and the
 * exceptions are the whole reason the field exists: a geocoder's confidence
 * modulates a landmark's score, and a coordinate pair that lands outside the
 * service area is demoted on suspicion of being transposed.
 *
 * Ranking by source alone silently discarded both adjustments — two candidates
 * with the same source tied, and the demoted one kept its original position.
 * The field was being written and never read.
 */
export function rankCandidates(
  candidates: LocationCandidate[],
): LocationCandidate[] {
  return [...candidates].sort((a, b) => {
    const aTrust = a.trust ?? LOCATION_SOURCE_TRUST[a.source];
    const bTrust = b.trust ?? LOCATION_SOURCE_TRUST[b.source];
    if (aTrust !== bTrust) return bTrust - aTrust;
    return Date.parse(b.obtained_at) - Date.parse(a.obtained_at);
  });
}

/* ------------------------------------------------------------------ *
 * Response units
 * ------------------------------------------------------------------ */

export const ResponseUnitKind = z.enum([
  "ambulance",
  "police_vehicle",
  "fire_tender",
  "rescue_team",
  "hospital",
  "police_station",
  "fire_station",
  "other",
]);
export type ResponseUnitKind = z.infer<typeof ResponseUnitKind>;

export const UnitAvailability = z.enum([
  "available",
  "assigned",
  "en_route",
  "on_scene",
  "unavailable",
  "unknown",
]);
export type UnitAvailability = z.infer<typeof UnitAvailability>;

/**
 * A candidate responding unit.
 *
 * Every distance carries its unit in the field name. The prototype computed
 * kilometres via the Haversine formula and rendered the result as "miles" —
 * a class of bug that only disappears when the unit is part of the contract.
 *
 * Note the separation of `road_distance_m` from `straight_line_m`. Straight-line
 * distance is kept only as a labelled fallback for when the routing engine is
 * unavailable; it is never the basis for a dispatch recommendation, because in
 * an Indian city one rail crossing or one-way flyover makes it meaningless.
 */
export const ResponseUnit = z.object({
  unit_id: z.string(),
  name: z.string(),
  kind: ResponseUnitKind,
  point: GeoPoint,

  /** Road network distance in metres, from the routing engine. */
  road_distance_m: z.number().nonnegative().nullable().default(null),

  /** Estimated travel time in seconds. The number that actually matters. */
  travel_time_s: z.number().nonnegative().nullable().default(null),

  /** Great-circle distance in metres. Fallback only; never for ranking. */
  straight_line_m: z.number().nonnegative(),

  /**
   * True when travel time was estimated from straight-line distance because
   * the routing engine was unreachable. Surfaced in the console so nobody
   * mistakes a fallback estimate for a routed one.
   */
  is_fallback_estimate: z.boolean().default(false),

  availability: UnitAvailability.default("unknown"),
  contact_number: z.string().nullable().default(null),
  address: z.string().nullable().default(null),
});
export type ResponseUnit = z.infer<typeof ResponseUnit>;

/* ------------------------------------------------------------------ *
 * Audit
 * ------------------------------------------------------------------ */

export const AuditEventType = z.enum([
  "incident_created",
  "segment_appended",
  "extraction_completed",
  "extraction_failed",
  "field_confirmed",
  "field_overridden",
  // Distinct from location_selected on purpose. The system resolving three
  // candidates and declining to choose between them is a real event with real
  // consequences — it is why the incident cannot be dispatched yet — and
  // recording it as a "selection" would make the audit trail say something
  // that did not happen.
  "location_candidates_updated",
  "location_selected",
  "escalated_to_human",
  "units_recommended",
  "dispatched",
  "status_changed",
  "merged_duplicate",
  "degraded_mode_entered",
]);
export type AuditEventType = z.infer<typeof AuditEventType>;

/**
 * One entry in the incident's append-only history.
 *
 * This is the artefact that makes the product defensible: being able to show,
 * for any incident, exactly what the system knew, when it knew it, what it
 * proposed, and what a human did about it. Nothing here is ever updated or
 * deleted — corrections are new events.
 */
export const AuditEvent = z.object({
  event_id: z.string().uuid(),
  incident_id: z.string().uuid(),
  type: AuditEventType,
  at: z.string().datetime(),

  /** Operator ID, or null when the system acted on its own. */
  actor: z.string().nullable().default(null),

  /** Dotted path of the affected field, e.g. "priority". */
  field_path: z.string().nullable().default(null),

  before: z.unknown().nullable().default(null),
  after: z.unknown().nullable().default(null),

  /** Free-form context: model ID, latency, error text, trigger reason. */
  detail: z.record(z.string(), z.unknown()).default({}),
});
export type AuditEvent = z.infer<typeof AuditEvent>;

/* ------------------------------------------------------------------ *
 * Data protection
 * ------------------------------------------------------------------ */

/**
 * DPDP Act 2023 / DPDP Rules 2025 handling metadata.
 *
 * Emergency processing falls under legitimate uses, so consent is not the
 * blocker here — but retention limits, security safeguards and breach
 * obligations still apply, and children's data carries heightened duties. That
 * last point is not hypothetical: ERSS routes a dedicated Children lane, so
 * this system will process minors' data by design.
 *
 * `may_use_for_training` defaults to false everywhere. Emergency call audio is
 * among the most sensitive personal data there is, and the default has to be
 * the conservative one.
 */
export const DataHandling = z.object({
  /** Deletion due date, set from the operating agency's retention policy. */
  retain_until: z.string().datetime().nullable().default(null),

  /** Never true without a specific, recorded lawful basis. */
  may_use_for_training: z.boolean().default(false),

  /** True when a minor's data is involved; triggers heightened obligations. */
  involves_minor: z.boolean().default(false),

  /** True once audio and transcript have been purged, leaving metadata only. */
  content_purged: z.boolean().default(false),
});
export type DataHandling = z.infer<typeof DataHandling>;

/* ------------------------------------------------------------------ *
 * Incident
 * ------------------------------------------------------------------ */

export const Incident = z.object({
  incident_id: z.string().uuid(),
  /** Operator-facing reference, e.g. "TS-2026-0830-00417". */
  reference: z.string(),

  status: IncidentStatus,

  /* ---- intake ---- */
  channel: IntakeChannel,
  primary_language: SpokenLanguage,
  caller_number_hash: z.string().nullable().default(null),
  received_at: z.string().datetime(),

  /* ---- classification: proposals until reviewed ---- */
  incident_type: reviewedField(IncidentType),
  priority: reviewedField(IncidentPriority),
  agencies: reviewedField(z.array(ResponseAgency)),
  people_affected: reviewedField(PeopleCount),
  caller_role: reviewedField(CallerRole),
  hazards: reviewedField(z.array(SceneHazard)),
  children_involved: reviewedField(z.boolean()),
  callback_number: reviewedField(z.string()),

  /* ---- resolved by the system ---- */
  location: ResolvedLocation,
  recommended_units: z.array(ResponseUnit).default([]),
  dispatched_units: z.array(z.string()).default([]),

  /* ---- narrative ---- */
  summary: z.string().default(""),

  /* ---- operating state ---- */
  transcript_quality: TranscriptQuality.nullable().default(null),
  escalation_triggers: z.array(EscalationTrigger).default([]),
  escalated_at: z.string().datetime().nullable().default(null),

  /**
   * True whenever the system is running below full capability — ASR degraded,
   * routing engine down, extraction failing. Always visible in the console.
   * Silent degradation is the failure mode this field exists to prevent.
   */
  degraded_mode: z.boolean().default(false),

  /** Set when this incident is suspected to duplicate another. */
  possible_duplicate_of: z.string().uuid().nullable().default(null),

  overall_confidence: Confidence.default(0),

  /* ---- governance ---- */
  data_handling: DataHandling,

  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  /** Optimistic concurrency guard. */
  version: z.number().int().nonnegative().default(0),
});
export type Incident = z.infer<typeof Incident>;

/* ------------------------------------------------------------------ *
 * Derived state
 * ------------------------------------------------------------------ */

/**
 * Whether this incident may proceed without a human taking over.
 *
 * Escalation is one-way: once any trigger fires, the call belongs to a person.
 * Nothing in the system clears a trigger automatically.
 */
export function requiresHuman(incident: Incident): boolean {
  return (
    incident.escalation_triggers.length > 0 ||
    incident.degraded_mode ||
    incident.children_involved.value === true ||
    incident.caller_role.value === "victim" ||
    incident.priority.value === "P0_immediate" ||
    incident.hazards.value !== null && incident.hazards.value.length > 0
  );
}

/** Fields a call-taker still needs to confirm before dispatch. */
export function unconfirmedFields(incident: Incident): string[] {
  const checks: Array<[string, { review: { state: string } }]> = [
    ["incident_type", incident.incident_type],
    ["priority", incident.priority],
    ["agencies", incident.agencies],
    ["people_affected", incident.people_affected],
  ];
  return checks
    .filter(([, f]) => f.review.state === "ai_proposed")
    .map(([name]) => name);
}

/** Whether the incident is complete enough to hand to a dispatcher. */
export function isDispatchReady(incident: Incident): {
  ready: boolean;
  blockers: string[];
} {
  const blockers: string[] = [];

  if (incident.location.selected_index === null) {
    blockers.push("no location selected");
  }
  if (incident.incident_type.value === null) {
    blockers.push("incident type not established");
  }
  if (incident.priority.value === null) {
    blockers.push("priority not established");
  }
  const pending = unconfirmedFields(incident);
  if (pending.length > 0) {
    blockers.push(`unconfirmed: ${pending.join(", ")}`);
  }

  return { ready: blockers.length === 0, blockers };
}
