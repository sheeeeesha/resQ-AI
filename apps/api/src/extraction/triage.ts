import {
  TriageExtraction,
  renderForExtraction,
  type TranscriptSegment,
} from "@resqai/schema";

import { ExtractionUnavailable, type ExtractionProvider } from "./provider.js";

export const TRIAGE_PROMPT_VERSION = "1.0.0";

/**
 * The fast triage pass.
 *
 * Everything here is shaped by one constraint: this runs while a caller is
 * still speaking, so it has a budget of a few seconds. The full extraction
 * takes 12-20 s on the same model and the same transcript, and that is the
 * right trade for a complete record and the wrong one for a routing decision.
 *
 * The prompt is short for the same reason. Every instruction costs tokens on
 * the path where tokens cost time, so this one states the job, the bias, and
 * nothing else. The full pass carries the careful instructions about evidence,
 * place names and consistency.
 */
const TRIAGE_INSTRUCTIONS = `
You are triaging a live emergency call in India. The caller is still speaking.

Decide two things only: what kind of incident this is, and how urgent it is.
Nothing else. Speed matters more than completeness here — a fuller analysis
runs separately a few seconds behind you.

The transcript may be Hindi, English, or the two mixed in one sentence. Read it
as it is.

Bias toward caution, deliberately:

  - If the caller describes anything that could be immediately life-threatening,
    set life_threat true. Being wrong costs a call-taker a glance. Being wrong
    the other way costs considerably more.
  - Use "unclear" freely for either field. Early in a call it is usually the
    correct answer, and a wrong lane sends the wrong vehicle.
  - Set needs_human when the caller is the victim, is not answering coherently,
    or asks for a person.

Set confidence to what you actually believe, not to what sounds decisive.
`.trim();

export interface TriageOutcome {
  triage: TriageExtraction | null;
  latencyMs: number;
  modelId: string;
  error: string | null;
  throughSegmentIndex: number;
}

export class TriageService {
  constructor(private readonly provider: ExtractionProvider) {}

  get modelId(): string {
    return this.provider.modelId;
  }

  async run(segments: TranscriptSegment[]): Promise<TriageOutcome> {
    const finals = segments.filter((s) => s.is_final);
    const throughSegmentIndex =
      finals.length > 0 ? Math.max(...finals.map((s) => s.index)) : -1;

    if (finals.length === 0) {
      return {
        triage: null,
        latencyMs: 0,
        modelId: this.provider.modelId,
        error: "no final segments",
        throughSegmentIndex,
      };
    }

    /*
     * Only the most recent utterances are sent.
     *
     * The lane and the priority are almost always decided by what the caller
     * said most recently, and a transcript that grows for the length of a call
     * would make the fast pass progressively slower — losing exactly the
     * property this pass exists for. The full pass reads everything.
     */
    const window = finals.slice(-8);

    const started = Date.now();

    try {
      const response = await this.provider.extract({
        prompt: `${TRIAGE_INSTRUCTIONS}\n\nTRANSCRIPT\n${renderForExtraction(window)}`,
        schema: TriageExtraction,
      });

      const parsed = TriageExtraction.safeParse(
        response.parsed ?? safeParse(response.rawText),
      );

      return {
        triage: parsed.success ? parsed.data : null,
        latencyMs: response.latencyMs,
        modelId: this.provider.modelId,
        // A malformed fast pass is not worth salvaging field by field. It is
        // two fields, it will run again in a few seconds, and the full pass is
        // already behind it — recovery machinery here would cost more latency
        // than the result is worth.
        error: parsed.success ? null : "triage output did not parse",
        throughSegmentIndex,
      };
    } catch (err) {
      return {
        triage: null,
        latencyMs: Date.now() - started,
        modelId: this.provider.modelId,
        error:
          err instanceof ExtractionUnavailable
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err),
        throughSegmentIndex,
      };
    }
  }
}

function safeParse(text: string | null): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
