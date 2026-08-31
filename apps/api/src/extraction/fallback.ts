import type { z } from "zod";
import type {
  ExtractionProvider,
  ExtractionRequest,
  ExtractionResponse,
} from "./provider.js";
import { ExtractionUnavailable } from "./provider.js";

/**
 * Tries one provider, falls back to another when it fails.
 *
 * Built after watching a real rate-limit take the primary provider out: the
 * pipeline degraded correctly — transcript stored, incident escalated — but the
 * call-taker got no classification at all, when keyword matching would have at
 * least routed the incident to a lane. Nothing beats a model; something beats
 * nothing.
 *
 * Two rules keep this honest:
 *
 *  - **Only retryable failures fall through.** A 429, a timeout or a 5xx means
 *    the primary might work later. A malformed request or a rejected key means
 *    it will not, and masking that behind a working fallback is how a
 *    misconfiguration survives to production looking healthy.
 *
 *  - **The fallback never claims to be the primary.** `modelId` reports which
 *    provider actually answered, so a stored classification stays attributable
 *    and the degraded-mode rate is measurable rather than hidden.
 */
export class FallbackExtractionProvider implements ExtractionProvider {
  /** Which provider answered most recently. Recorded on the extraction pass. */
  private lastUsed: string;

  constructor(
    private readonly primary: ExtractionProvider,
    private readonly fallback: ExtractionProvider,
    private readonly onFallback?: (reason: string) => void,
  ) {
    this.lastUsed = primary.modelId;
  }

  get modelId(): string {
    return this.lastUsed;
  }

  async extract<T extends z.ZodType>(
    request: ExtractionRequest<T>,
  ): Promise<ExtractionResponse> {
    try {
      const response = await this.primary.extract(request);
      this.lastUsed = this.primary.modelId;
      return response;
    } catch (err) {
      const retryable = err instanceof ExtractionUnavailable && err.retryable;

      // A permanent failure is a configuration problem. Surfacing it beats
      // quietly running on keyword matching for a week.
      if (!retryable) {
        this.lastUsed = this.primary.modelId;
        throw err;
      }

      this.onFallback?.(err instanceof Error ? err.message : String(err));
      this.lastUsed = this.fallback.modelId;
      return this.fallback.extract(request);
    }
  }
}
