import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import {
  ExtractionUnavailable,
  type ExtractionProvider,
  type ExtractionRequest,
  type ExtractionResponse,
} from "./provider.js";

/**
 * Claude extraction provider.
 *
 * Uses structured outputs (`output_config.format`), which constrains generation
 * against the schema rather than asking politely for JSON. That is the whole
 * reason this replaces the prototype's prompt-then-`JSON.parse` approach: the
 * failure mode we are engineering out is a malformed response degrading an
 * entire incident record to "Unknown".
 *
 * Two settings deserve their reasoning written down:
 *
 * **Effort.** This is a bounded extraction against a short transcript, not open
 * reasoning — but it runs on a live emergency contact where both accuracy and
 * seconds matter. `medium` is the default compromise. The reference result in
 * this field (Corti, Copenhagen) turned on a ten-second improvement in
 * time-to-recognition, so latency here is not a comfort concern. Configurable,
 * because the right setting is an empirical question M6 will answer with data
 * rather than one to settle by argument now.
 *
 * **Thinking stays on.** Opus 5 runs adaptive thinking by default, and
 * disabling it has documented failure modes — including tool calls written into
 * visible text. Lowering effort is the correct way to trade depth for speed;
 * switching thinking off is not.
 */

export interface ClaudeProviderConfig {
  apiKey?: string;
  model?: string;

  /**
   * Override the API host.
   *
   * Any gateway implementing Anthropic's Messages API works here — OpenCode
   * Zen's `https://opencode.ai/zen/v1` among them. The wire format is
   * identical, so nothing else in this class changes.
   *
   * One caveat worth holding onto: a gateway is a real dependency, not a
   * transparent pipe. Whether it forwards `output_config.format` — and
   * therefore whether generation is genuinely schema-constrained rather than
   * merely asked for JSON — is a property of that gateway, not of the model.
   * `structuredOutputVerified` on the response records what actually happened
   * so this is measured rather than assumed.
   */
  baseUrl?: string;

  /** Depth/speed trade-off. See the note above. */
  effort?: "low" | "medium" | "high";
  maxTokens?: number;
  /** Hard ceiling per pass. A late answer on a live contact is a lost one. */
  timeoutMs?: number;
}

export class ClaudeExtractionProvider implements ExtractionProvider {
  readonly modelId: string;

  private readonly client: Anthropic;
  private readonly effort: "low" | "medium" | "high";
  private readonly maxTokens: number;
  private readonly timeoutMs: number;

  constructor(config: ClaudeProviderConfig = {}) {
    this.modelId = config.model ?? "claude-opus-5";
    this.effort = config.effort ?? "medium";
    this.maxTokens = config.maxTokens ?? 8_000;
    this.timeoutMs = config.timeoutMs ?? 15_000;

    this.client = new Anthropic({
      // Falls back to ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN or a stored
      // `ant auth login` profile when not passed explicitly.
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
      timeout: this.timeoutMs,
      // One retry only. On a live contact a third attempt arrives after the
      // information stopped being useful; the pipeline would rather degrade
      // and escalate to a human than keep waiting.
      maxRetries: 1,
    });
  }

  async extract<T extends z.ZodType>(
    request: ExtractionRequest<T>,
  ): Promise<ExtractionResponse> {
    const started = Date.now();

    try {
      const response = await this.client.messages.parse({
        model: this.modelId,
        max_tokens: this.maxTokens,
        output_config: {
          effort: this.effort,
          format: zodOutputFormat(request.schema),
        },
        messages: [{ role: "user", content: request.prompt }],
      });

      const latencyMs = Date.now() - started;

      // A refusal is not an error — it is a 200 with nothing usable. Treat it
      // as an unavailable pass so the caller escalates rather than storing an
      // empty classification as though it were a finding.
      if (response.stop_reason === "refusal") {
        throw new ExtractionUnavailable(
          this.modelId,
          `model declined: ${response.stop_details?.category ?? "unspecified"}`,
          false,
        );
      }

      // Raw text is kept even on the success path so field-level recovery has
      // something to work from if the strict parse later proves unusable.
      const rawText = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("");

      return {
        parsed: response.parsed_output ?? null,
        rawText: rawText || null,
        // The SDK populates parsed_output only when the response conformed to
        // the declared format. A gateway that drops output_config leaves it
        // null, which is exactly what we want to notice.
        structuredOutput: response.parsed_output != null,
        latencyMs,
        usage: {
          input: response.usage.input_tokens,
          output: response.usage.output_tokens,
        },
      };
    } catch (err) {
      if (err instanceof ExtractionUnavailable) throw err;

      // Classify by SDK error type rather than message text, and mark which
      // failures are worth another pass. The next pass runs on a longer
      // transcript anyway, so a retryable failure is rarely wasted.
      if (err instanceof Anthropic.RateLimitError) {
        throw new ExtractionUnavailable(this.modelId, "rate limited", true);
      }
      if (err instanceof Anthropic.AuthenticationError) {
        throw new ExtractionUnavailable(this.modelId, "authentication failed", false);
      }
      if (err instanceof Anthropic.APIConnectionTimeoutError) {
        throw new ExtractionUnavailable(
          this.modelId,
          `timed out after ${this.timeoutMs}ms`,
          true,
        );
      }
      if (err instanceof Anthropic.APIConnectionError) {
        throw new ExtractionUnavailable(this.modelId, "connection failed", true);
      }
      if (err instanceof Anthropic.APIError) {
        throw new ExtractionUnavailable(
          this.modelId,
          `API error ${err.status}: ${err.message}`,
          err.status !== undefined && err.status >= 500,
        );
      }

      throw new ExtractionUnavailable(
        this.modelId,
        err instanceof Error ? err.message : String(err),
        false,
      );
    }
  }
}
