import type { z } from "zod";
import type {
  IncidentPriority,
  IncidentType,
  ResponseAgency,
  SceneHazard,
} from "@resqai/schema";
import { DEFAULT_AGENCY } from "@resqai/schema";
import type {
  ExtractionProvider,
  ExtractionRequest,
  ExtractionResponse,
} from "./provider.js";

/**
 * A keyword extractor over the transcript.
 *
 * Serves two purposes, and is honest about being weak at both:
 *
 *  1. **Test double.** The whole pipeline — intake, extraction, merge,
 *     escalation, persistence — is exercised end to end with no API key and no
 *     network. A pipeline that can only be tested against a paid external
 *     service stops being tested.
 *
 *  2. **Degraded-mode fallback.** When the model provider is unavailable, this
 *     still recognises "aag", "fire", "accident", "khoon" and routes an
 *     incident to a plausible lane. Everything it emits is capped at low
 *     confidence and always escalates, so a call-taker is never shown its
 *     output as though a model had assessed it.
 *
 * This is emphatically not a classifier. It matches words. It cannot read
 * negation ("there is no fire"), it cannot weigh context, and it will
 * mis-handle sarcasm, hypotheticals and reported speech. Those limits are the
 * reason every field it produces is marked for human review.
 */

const LOW_CONFIDENCE = 0.4;

/** Keyword sets, deliberately covering both Devanagari and romanised forms. */
const TYPE_KEYWORDS: Array<{ type: IncidentType; words: string[] }> = [
  {
    type: "fire_structure",
    words: ["fire", "aag", "आग", "burning", "jal raha", "smoke", "dhuan", "धुआं"],
  },
  {
    type: "road_traffic_accident",
    words: [
      "accident", "haadsa", "हादसा", "दुर्घटना", "collision", "takkar", "टक्कर",
      "car hit", "bike", "truck", "crash",
    ],
  },
  {
    type: "medical_cardiac",
    words: ["heart attack", "cardiac", "dil ka daura", "chest pain", "seene mein dard"],
  },
  {
    type: "medical_breathing",
    words: ["not breathing", "saans nahi", "सांस", "breathing", "choking", "dam ghut"],
  },
  {
    type: "medical_unconscious",
    words: ["unconscious", "behosh", "बेहोश", "collapsed", "gir gaya", "fainted"],
  },
  {
    type: "medical_trauma",
    words: ["bleeding", "khoon", "खून", "injured", "ghayal", "घायल", "zakhmi", "wound"],
  },
  {
    type: "crime_assault",
    words: ["assault", "beating", "maar", "मार", "attack", "hamla", "हमला", "fight"],
  },
  {
    type: "crime_domestic_violence",
    words: ["domestic", "husband hitting", "ghar mein maar", "dowry"],
  },
  { type: "drowning", words: ["drowning", "doob", "डूब", "water", "paani mein"] },
  {
    type: "electrocution",
    words: ["electric", "shock", "current", "bijli", "बिजली", "wire"],
  },
  {
    type: "structural_collapse",
    words: ["collapse", "building gir", "इमारत", "makaan gir", "wall fell"],
  },
  { type: "gas_leak", words: ["gas leak", "cylinder", "gas ki smell", "lpg"] },
];

const HAZARD_KEYWORDS: Array<{ hazard: SceneHazard; words: string[] }> = [
  { hazard: "weapon_present", words: ["gun", "knife", "chaku", "pistol", "weapon", "hathiyar"] },
  { hazard: "fire_spreading", words: ["spreading", "phail raha", "more floors"] },
  { hazard: "gas_or_chemical", words: ["gas", "chemical", "cylinder", "fumes"] },
  { hazard: "electrical_live", words: ["live wire", "current", "bijli ka taar"] },
  { hazard: "deep_or_fast_water", words: ["deep water", "current", "nadi", "river"] },
  { hazard: "ongoing_traffic", words: ["highway", "traffic", "orr", "expressway", "road par"] },
  { hazard: "structural_unstable", words: ["unstable", "gir sakta", "cracking"] },
];

/** Words that suggest an immediate threat to life. */
const CRITICAL_WORDS = [
  "dying", "mar raha", "मर रहा", "not breathing", "saans nahi", "unconscious",
  "behosh", "trapped", "phansa", "फंसा", "bleeding heavily", "bahut khoon",
];

const CHILD_WORDS = ["child", "bachcha", "बच्चा", "baby", "kid", "beti", "beta", "infant"];

const SELF_WORDS = ["i am", "mujhe", "मुझे", "my leg", "mera", "help me", "bachao"];

function findAll(haystack: string, words: string[]): boolean {
  return words.some((w) => haystack.includes(w));
}

export class RuleBasedExtractionProvider implements ExtractionProvider {
  readonly modelId = "rule-based-v1";

  async extract<T extends z.ZodType>(
    request: ExtractionRequest<T>,
  ): Promise<ExtractionResponse> {
    const started = Date.now();

    // The prompt embeds the transcript as "[s0] caller: ...". Pull the segment
    // IDs back out so extracted fields can cite real evidence — a field that
    // cannot point at a segment is not "extracted", and that rule applies to
    // this provider exactly as it does to the model.
    const segments = [...request.prompt.matchAll(/\[(s\d+)\]\s+(\w+)[^:]*:\s*(.*)/g)].map(
      (m) => ({ id: m[1]!, speaker: m[2]!, text: m[3]!.toLowerCase() }),
    );
    const callerSegments = segments.filter((s) => s.speaker === "caller");
    const haystack = callerSegments.map((s) => s.text).join(" ");
    const allIds = callerSegments.map((s) => s.id);

    /** Cites the segments that actually contain one of `words`. */
    const evidenceFor = (words: string[]): string[] =>
      callerSegments
        .filter((s) => words.some((w) => s.text.includes(w)))
        .map((s) => s.id)
        .slice(0, 4);

    const matchedType = TYPE_KEYWORDS.find((t) => findAll(haystack, t.words));
    const hazards = HAZARD_KEYWORDS.filter((h) => findAll(haystack, h.words)).map(
      (h) => h.hazard,
    );
    const critical = findAll(haystack, CRITICAL_WORDS);
    const childInvolved = findAll(haystack, CHILD_WORDS);
    const selfReported = findAll(haystack, SELF_WORDS);

    const field = <V>(value: V | null, words?: string[]) =>
      value === null
        ? { value: null, status: "not_stated" as const, confidence: 0, evidence: [] }
        : {
            value,
            status: "extracted" as const,
            confidence: LOW_CONFIDENCE,
            evidence: words ? evidenceFor(words) : allIds.slice(0, 1),
          };

    const type: IncidentType | null = matchedType?.type ?? null;

    // The children lane is added whenever a minor is involved, not just when
    // the incident type implies it. Omitting it produced a real contradiction
    // that the semantic validator flagged on live traffic: children_involved
    // true with the children lane unrouted.
    const agencies: ResponseAgency[] | null = type
      ? [
          ...new Set<ResponseAgency>([
            DEFAULT_AGENCY[type],
            ...(childInvolved ? (["children"] as const) : []),
          ]),
        ]
      : null;
    const priority: IncidentPriority | null = type
      ? critical
        ? "P0_immediate"
        : "P1_urgent"
      : null;

    const result = {
      incident_type: field(type, matchedType?.words),
      priority: field(priority, matchedType?.words),
      agencies: field(agencies, matchedType?.words),
      location: field(null),
      people_affected: field(null),
      caller_role: field(selfReported ? ("victim" as const) : null, SELF_WORDS),
      hazards: hazards.length > 0 ? field(hazards) : field([] as SceneHazard[]),
      children_involved: field(childInvolved ? true : null, CHILD_WORDS),
      callback_number: field(null),
      summary: type
        ? `Keyword match only: possible ${type.replace(/_/g, " ")}. Not model-assessed — confirm every field with the contact.`
        : "No incident type recognised by keyword matching. Requires a call-taker.",
      // Always escalates. This provider is never permitted to be the last word.
      escalation_triggers: [
        "system_degraded" as const,
        ...(critical ? (["life_threat_indicated"] as const) : []),
        ...(hazards.length > 0 ? (["hazard_indicated"] as const) : []),
        ...(childInvolved ? (["child_involved"] as const) : []),
        ...(selfReported ? (["caller_is_involved"] as const) : []),
      ].slice(0, 6),
      overall_confidence: type ? LOW_CONFIDENCE : 0,
    };

    return {
      parsed: result,
      rawText: JSON.stringify(result),
      // Constructed in code against the contract, so conformance is not in
      // question — but it is keyword matching, not constrained generation.
      structuredOutput: true,
      latencyMs: Date.now() - started,
    };
  }
}
