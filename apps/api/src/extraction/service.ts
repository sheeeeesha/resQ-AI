import {
  IncidentExtraction,
  MedicalSupplement,
  validateSemantics,
  checkFieldInvariants,
  EXTRACTION_CONTRACT_VERSION,
  type TranscriptSegment,
} from "@resqai/schema";
import { buildExtractionPrompt, buildMedicalPrompt, PROMPT_VERSION } from "./prompt.js";
import {
  ExtractionUnavailable,
  type ExtractionProvider,
} from "./provider.js";

/**
 * The extraction service.
 *
 * Sits between the provider and the incident, and owns three guarantees the
 * provider deliberately does not:
 *
 *  1. **Malformed output cannot reach the database.** Everything is parsed
 *     against the contract before it goes anywhere.
 *
 *  2. **A failure degrades one field, not the record.** If the strict parse
 *     fails, fields are recovered individually and only the unparseable ones
 *     are lost. The prototype collapsed the entire incident to "Unknown" when
 *     a single value came back wrong.
 *
 *  3. **Cited evidence is real.** A model can invent segment IDs. Citations are
 *     checked against the transcript actually sent, and invented ones are
 *     stripped rather than stored as provenance that leads nowhere.
 */

export interface ExtractionOutcome {
  /** Null only when nothing usable survived. */
  core: IncidentExtraction | null;
  medical: MedicalSupplement | null;

  /** Semantic contradictions and evidence problems. Logged, never thrown. */
  problems: string[];

  /** Fields lost to recovery. Present in the record as `unclear`, not absent. */
  degradedFields: string[];

  modelId: string;
  promptVersion: string;
  contractVersion: string;
  latencyMs: number;
  throughSegmentIndex: number;

  /**
   * Whether generation was genuinely schema-constrained on this pass.
   *
   * Worth recording per pass rather than assuming from configuration: it is a
   * property of the endpoint, and a gateway that quietly drops
   * `output_config.format` is indistinguishable from one that honours it
   * until this is measured.
   */
  structuredOutput: boolean;

  /** Set when the pass failed outright. */
  error: string | null;
  /** Whether another pass might succeed. */
  retryable: boolean;
}

export interface ExtractionServiceConfig {
  provider: ExtractionProvider;
  /** Runs the medical follow-up when the health lane is indicated. */
  medicalPass?: boolean;
}

export class ExtractionService {
  constructor(private readonly config: ExtractionServiceConfig) {}

  async run(
    segments: TranscriptSegment[],
    options: { language?: string } = {},
  ): Promise<ExtractionOutcome> {
    const finals = segments.filter((s) => s.is_final);
    const throughSegmentIndex =
      finals.length > 0 ? Math.max(...finals.map((s) => s.index)) : -1;

    // `modelId` is read fresh after each call rather than captured here. A
    // fallback provider only knows which model answered once it has answered,
    // and recording the one we *intended* to use would misattribute every
    // degraded pass to the model that was actually unavailable.
    const base = () => ({
      modelId: this.config.provider.modelId,
      promptVersion: PROMPT_VERSION,
      contractVersion: EXTRACTION_CONTRACT_VERSION,
      throughSegmentIndex,
    });

    if (finals.length === 0) {
      return {
        ...base(),
        core: null,
        medical: null,
        problems: [],
        degradedFields: [],
        latencyMs: 0,
        structuredOutput: false,
        error: "no final segments to extract from",
        retryable: true,
      };
    }

    const validSegmentIds = new Set(finals.map((s) => s.id));

    let response;
    try {
      response = await this.config.provider.extract({
        prompt: buildExtractionPrompt({ segments: finals, language: options.language }),
        schema: IncidentExtraction,
      });
    } catch (err) {
      const unavailable = err instanceof ExtractionUnavailable;
      return {
        ...base(),
        core: null,
        medical: null,
        problems: [],
        degradedFields: [],
        latencyMs: 0,
        structuredOutput: false,
        error: err instanceof Error ? err.message : String(err),
        retryable: unavailable ? err.retryable : false,
      };
    }

    const recovery = recoverExtraction(response.parsed, response.rawText);

    if (!recovery.core) {
      return {
        ...base(),
        core: null,
        medical: null,
        problems: recovery.problems,
        degradedFields: recovery.degradedFields,
        latencyMs: response.latencyMs,
        structuredOutput: response.structuredOutput,
        error: "no usable fields survived parsing",
        retryable: true,
      };
    }

    const problems = [
      ...recovery.problems,
      ...validateSemantics(recovery.core),
      ...checkAllFieldInvariants(recovery.core),
      ...pruneInvalidEvidence(recovery.core, validSegmentIds),
    ];

    // The medical supplement only runs when the health lane is actually
    // indicated, so the extra call is paid for only when it is relevant.
    let medical: MedicalSupplement | null = null;
    if (this.config.medicalPass && indicatesHealthLane(recovery.core)) {
      medical = await this.runMedicalPass(finals, validSegmentIds, problems);
    }

    return {
      ...base(),
      core: recovery.core,
      medical,
      problems,
      degradedFields: recovery.degradedFields,
      latencyMs: response.latencyMs,
      structuredOutput: response.structuredOutput,
      error: null,
      retryable: false,
    };
  }

  private async runMedicalPass(
    segments: TranscriptSegment[],
    validSegmentIds: Set<string>,
    problems: string[],
  ): Promise<MedicalSupplement | null> {
    try {
      const response = await this.config.provider.extract({
        prompt: buildMedicalPrompt({ segments }),
        schema: MedicalSupplement,
      });
      const parsed = MedicalSupplement.safeParse(response.parsed);
      if (!parsed.success) {
        // The supplement is additive. Losing it must never cost us the core
        // classification, so it degrades to absent and says so.
        problems.push("medical supplement failed to parse; core retained");
        return null;
      }
      problems.push(...pruneInvalidEvidence(parsed.data, validSegmentIds));
      return parsed.data;
    } catch {
      problems.push("medical supplement unavailable; core retained");
      return null;
    }
  }
}

/* ------------------------------------------------------------------ *
 * Recovery
 * ------------------------------------------------------------------ */

interface Recovery {
  core: IncidentExtraction | null;
  degradedFields: string[];
  problems: string[];
}

/** A field that could not be recovered: present, explicitly unresolved. */
const UNCLEAR_FIELD = {
  value: null,
  status: "unclear" as const,
  confidence: 0,
  evidence: [] as string[],
};

/**
 * Parses an extraction, salvaging what it can.
 *
 * The fast path is a strict parse of the whole object. When that fails, each
 * field is parsed on its own and only the broken ones are replaced with an
 * explicit `unclear` marker — so one bad value costs one field rather than the
 * whole record, and the loss is visible in the incident instead of silent.
 */
export function recoverExtraction(
  parsed: unknown,
  rawText: string | null,
): Recovery {
  const candidate = parsed ?? safeJsonParse(rawText);
  if (candidate === null || typeof candidate !== "object") {
    return { core: null, degradedFields: [], problems: ["output was not an object"] };
  }

  const strict = IncidentExtraction.safeParse(candidate);
  if (strict.success) {
    return { core: strict.data, degradedFields: [], problems: [] };
  }

  const source = candidate as Record<string, unknown>;
  const shape = IncidentExtraction.shape;
  const rebuilt: Record<string, unknown> = {};
  const degraded: string[] = [];
  const problems: string[] = [];

  for (const [name, fieldSchema] of Object.entries(shape)) {
    const fieldResult = fieldSchema.safeParse(source[name]);
    if (fieldResult.success) {
      rebuilt[name] = fieldResult.data;
      continue;
    }

    degraded.push(name);

    // Scalars that are not field envelopes need their own sane fallbacks.
    if (name === "summary") {
      rebuilt[name] = "";
    } else if (name === "escalation_triggers") {
      // A pass that damaged its own output is exactly when a human should look.
      rebuilt[name] = ["low_confidence"];
    } else if (name === "overall_confidence") {
      rebuilt[name] = 0;
    } else {
      rebuilt[name] = { ...UNCLEAR_FIELD };
    }
  }

  const recovered = IncidentExtraction.safeParse(rebuilt);
  if (!recovered.success) {
    return {
      core: null,
      degradedFields: degraded,
      problems: ["field-level recovery failed to produce a valid extraction"],
    };
  }

  problems.push(
    `recovered ${degraded.length} field(s) after a failed strict parse: ${degraded.join(", ")}`,
  );

  // A pass that lost fields is not trustworthy at its stated confidence.
  if (degraded.length > 0 && !recovered.data.escalation_triggers.includes("low_confidence")) {
    recovered.data.escalation_triggers = [
      ...recovered.data.escalation_triggers,
      "low_confidence" as const,
    ].slice(0, 6);
  }

  return { core: recovered.data, degradedFields: degraded, problems };
}

function safeJsonParse(text: string | null): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // Providers occasionally wrap JSON in prose or fences despite constrained
    // decoding. One salvage attempt, then give up — this is a fallback, not a
    // parser, and the prototype's regex-stripping approach is what we replaced.
    const match = /\{[\s\S]*\}/.exec(text);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

/* ------------------------------------------------------------------ *
 * Evidence
 * ------------------------------------------------------------------ */

interface EnvelopeLike {
  status: string;
  confidence: number;
  evidence: string[];
}

function isEnvelope(v: unknown): v is EnvelopeLike {
  return (
    typeof v === "object" &&
    v !== null &&
    "status" in v &&
    "evidence" in v &&
    Array.isArray((v as EnvelopeLike).evidence)
  );
}

/**
 * Removes citations that point at segments which were never sent.
 *
 * Mutates in place, deliberately: a hallucinated segment ID is worse than no
 * citation at all, because it looks like provenance and leads a reviewer to a
 * segment that does not exist. Stripping it and recording the problem keeps
 * the audit trail honest.
 */
export function pruneInvalidEvidence(
  extraction: Record<string, unknown>,
  validIds: Set<string>,
): string[] {
  const problems: string[] = [];

  for (const [name, value] of Object.entries(extraction)) {
    if (!isEnvelope(value)) continue;

    const invented = value.evidence.filter((id) => !validIds.has(id));
    if (invented.length > 0) {
      value.evidence = value.evidence.filter((id) => validIds.has(id));
      problems.push(
        `${name}: cited segment(s) not in transcript: ${invented.join(", ")}`,
      );
    }

    // A confident claim with nothing behind it is usually an inference the
    // transcript does not support.
    if (value.status === "extracted" && value.confidence > 0.8 && value.evidence.length === 0) {
      problems.push(`${name}: high confidence with no surviving evidence`);
    }
  }

  return problems;
}

function checkAllFieldInvariants(core: IncidentExtraction): string[] {
  const problems: string[] = [];
  for (const [name, value] of Object.entries(core)) {
    if (isEnvelope(value)) {
      problems.push(
        ...checkFieldInvariants(name, value as never),
      );
    }
  }
  return problems;
}

function indicatesHealthLane(core: IncidentExtraction): boolean {
  if (core.agencies.value?.includes("health")) return true;
  return core.incident_type.value?.startsWith("medical_") ?? false;
}
