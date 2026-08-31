import type { z } from "zod";

/**
 * The extraction provider interface.
 *
 * Narrow on purpose: a provider takes a prompt and a schema and returns
 * whatever the model produced, plus timing. It does no interpretation, no
 * merging and no escalation logic — all of that belongs to the service, so
 * swapping models cannot quietly change how results are handled.
 *
 * The schema is not advisory. Providers are expected to enforce it through
 * constrained decoding, which makes malformed output structurally impossible
 * rather than merely unlikely. A provider that can only be *asked* to return
 * JSON is not suitable here — that was the prototype's approach, and it is
 * reliable 80-95% of the time.
 *
 * Zod rather than raw JSON Schema, because Zod is already the single source of
 * truth for every contract in this system. Providers whose APIs want JSON
 * Schema convert on the way out via `toStrictJsonSchema`, which also lets each
 * provider apply its own dialect quirks without leaking them upward.
 */

export interface ExtractionRequest<T extends z.ZodType = z.ZodType> {
  prompt: string;
  schema: T;
}

export interface ExtractionResponse {
  /**
   * The model's output, parsed against the schema where the provider managed
   * it. Null when the provider returned something that would not parse — the
   * service then attempts field-level recovery from `rawText` rather than
   * discarding the whole pass.
   */
  parsed: unknown | null;

  /** The raw text as returned, kept so a failed parse can still be salvaged. */
  rawText: string | null;

  latencyMs: number;

  /**
   * Whether generation was genuinely schema-constrained.
   *
   * True when the provider returned output the schema parser accepted
   * directly. False means we fell back to salvaging raw text — which still
   * usually works, but is the 80-95% tier the prototype lived in rather than
   * the ~100% tier constrained decoding provides.
   *
   * Recorded rather than assumed because it is a property of the *endpoint*,
   * not the model: a gateway that silently drops `output_config.format` looks
   * identical from the outside until you measure this.
   */
  structuredOutput: boolean;

  /** Token usage, where the provider reports it. For cost tracking. */
  usage?: { input: number; output: number };
}

export interface ExtractionProvider {
  /** Recorded on every pass so a stored classification stays attributable. */
  readonly modelId: string;
  extract<T extends z.ZodType>(
    request: ExtractionRequest<T>,
  ): Promise<ExtractionResponse>;
}

export class ExtractionUnavailable extends Error {
  constructor(
    public readonly modelId: string,
    cause: string,
    public readonly retryable: boolean,
  ) {
    super(`Extraction provider ${modelId} unavailable: ${cause}`);
    this.name = "ExtractionUnavailable";
  }
}
