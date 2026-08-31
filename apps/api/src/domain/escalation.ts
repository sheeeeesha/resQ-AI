import type {
  EscalationTrigger,
  IncidentExtraction,
  TranscriptQuality,
} from "@resqai/schema";
import { ROUTING_CONFIDENCE_THRESHOLD } from "@resqai/schema";

/**
 * Escalation evaluation.
 *
 * Decides when a contact stops being assisted and starts belonging to a person.
 * Three properties hold throughout, and all three are deliberate:
 *
 *  **Additive only.** Nothing here clears a trigger. Once any condition has
 *  said a human should look at this, no later pass gets to decide otherwise —
 *  a model that grew more confident on a longer transcript is not evidence that
 *  the earlier concern was wrong.
 *
 *  **Cheap to raise.** Every rule errs toward escalating. A false escalation
 *  costs a call-taker a few seconds. A missed one costs considerably more, and
 *  the asymmetry is the entire design.
 *
 *  **Independent of the model's own judgement.** The model may raise triggers
 *  in its output, and those are honoured — but these rules run regardless, so a
 *  model that fails to flag a hazard it correctly extracted still escalates.
 */

export interface EscalationInput {
  extraction: IncidentExtraction | null;
  quality: TranscriptQuality | null;
  /** True when extraction failed or a component is unavailable. */
  systemDegraded: boolean;
  /** Semantic problems found after decoding. */
  problems: string[];
  /** Whether the caller's language is one we can currently handle. */
  languageSupported: boolean;
}

export function evaluateEscalation(input: EscalationInput): EscalationTrigger[] {
  const triggers = new Set<EscalationTrigger>();

  // The model's own judgement is taken at face value when it raises a concern.
  for (const t of input.extraction?.escalation_triggers ?? []) {
    triggers.add(t);
  }

  if (input.systemDegraded) triggers.add("system_degraded");
  if (!input.languageSupported) triggers.add("language_unsupported");

  // Contradictions in the output mean the classification cannot be relied on,
  // whatever confidence it claims.
  if (input.problems.length > 0) triggers.add("contradictory_information");

  // Poor audio. Not applicable on text channels, where quality is null.
  if (input.quality?.degraded) triggers.add("asr_quality_poor");

  const e = input.extraction;
  if (!e) {
    // No extraction at all is itself a reason for a person to take over.
    triggers.add("low_confidence");
    return [...triggers];
  }

  if (e.overall_confidence < ROUTING_CONFIDENCE_THRESHOLD) {
    triggers.add("low_confidence");
  }

  // A contact reporting their own emergency cannot be expected to answer
  // structured questions calmly. This is one of the standard escalation rules
  // in the live US deployments, and it is the right instinct.
  if (e.caller_role.value === "victim") triggers.add("caller_is_involved");

  if (e.priority.value === "P0_immediate") triggers.add("life_threat_indicated");

  if ((e.hazards.value?.length ?? 0) > 0) triggers.add("hazard_indicated");

  if (e.children_involved.value === true) triggers.add("child_involved");

  // A classification the system would not act on automatically is one a person
  // should see, even when nothing else fired.
  if (
    e.incident_type.status !== "extracted" ||
    e.incident_type.confidence < ROUTING_CONFIDENCE_THRESHOLD
  ) {
    triggers.add("low_confidence");
  }

  // The schema caps the array; keep the most operationally significant ones if
  // more fired than fit.
  return prioritise([...triggers]).slice(0, 6);
}

/** Orders triggers so a truncated list keeps the ones that change handling most. */
const TRIGGER_RANK: Record<EscalationTrigger, number> = {
  life_threat_indicated: 0,
  caller_is_involved: 1,
  child_involved: 2,
  hazard_indicated: 3,
  system_degraded: 4,
  caller_requested_human: 5,
  contradictory_information: 6,
  asr_quality_poor: 7,
  language_unsupported: 8,
  silence_or_no_response: 9,
  low_confidence: 10,
};

function prioritise(triggers: EscalationTrigger[]): EscalationTrigger[] {
  return [...triggers].sort((a, b) => TRIGGER_RANK[a] - TRIGGER_RANK[b]);
}

/**
 * Merges newly-evaluated triggers with those already on the incident.
 *
 * The union, always. This is what makes escalation one-way in practice rather
 * than merely in intent.
 */
export function mergeTriggers(
  existing: EscalationTrigger[],
  incoming: EscalationTrigger[],
): EscalationTrigger[] {
  return prioritise([...new Set([...existing, ...incoming])]);
}
