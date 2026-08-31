import type { z } from "zod";
import { toStrictJsonSchema } from "@resqai/schema";
import {
  ExtractionUnavailable,
  type ExtractionProvider,
  type ExtractionRequest,
  type ExtractionResponse,
} from "./provider.js";

/**
 * Provider for any OpenAI-compatible endpoint.
 *
 * Covers OpenCode Go/Zen, DeepSeek direct, OpenRouter, Together, vLLM and
 * anything else speaking `/chat/completions`. Written against plain `fetch`
 * rather than an SDK: the surface used here is one endpoint, and owning the
 * request means owning the error mapping and the capability fallback, both of
 * which matter more than the convenience.
 *
 * ## Why tool calling rather than JSON mode
 *
 * These endpoints do not all enforce schemas, and the difference is large:
 *
 *   constrained decoding  ~100%  schema-valid (Claude structured outputs)
 *   forced tool calling   95-99% schema-valid
 *   JSON mode             valid JSON, *no* schema guarantee
 *   prompt-and-parse      80-95% (what the prototype did)
 *
 * DeepSeek in particular rejects `response_format: {type: "json_schema"}`
 * outright — it supports only `json_object`, which guarantees the response
 * parses but says nothing about fields, types or enums. Function calling is
 * the strongest option those endpoints actually offer, so it is the default
 * here and JSON mode is the fallback.
 *
 * The consequence is that field-level recovery in the extraction service stops
 * being a safety net and becomes load-bearing. That is a deliberate, stated
 * trade — not an accident — and `structuredOutput` on the response records
 * which path a given pass actually took so the cost is measurable rather than
 * assumed.
 */

const TOOL_NAME = "record_incident";

export interface OpenAICompatibleConfig {
  apiKey: string;
  /** e.g. https://opencode.ai/zen/v1 — no trailing /chat/completions. */
  baseUrl: string;
  model: string;
  maxTokens?: number;
  timeoutMs?: number;
  /**
   * Force JSON mode instead of tool calling.
   *
   * Only for endpoints that accept tools but handle them badly. Measurably
   * weaker; prefer fixing the endpoint choice over setting this.
   */
  preferJsonMode?: boolean;
  /** Extra headers some gateways require for routing or attribution. */
  headers?: Record<string, string>;
}

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
    };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; type?: string; code?: string };
}

export class OpenAICompatibleProvider implements ExtractionProvider {
  readonly modelId: string;

  private readonly endpoint: string;
  private readonly maxTokens: number;
  private readonly timeoutMs: number;

  /**
   * Whether this endpoint has been observed to reject tool calling.
   *
   * Learned once at runtime rather than configured, because the docs for these
   * gateways frequently disagree with their behaviour. After a rejection we
   * stop paying for a failed round trip on every subsequent pass.
   */
  private toolsRejected = false;

  constructor(private readonly config: OpenAICompatibleConfig) {
    this.modelId = config.model;
    this.endpoint = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    this.maxTokens = config.maxTokens ?? 8_000;
    // 35s, measured rather than guessed. The Go-tier models answer this
    // schema in 12-20s and the flagships in 25-35s; a 20s ceiling silently
    // failed half of them. Still far too slow for a live voice call — see the
    // latency note in docs/setup.md — but workable for text intake.
    this.timeoutMs = config.timeoutMs ?? 35_000;
    this.toolsRejected = config.preferJsonMode ?? false;
  }

  async extract<T extends z.ZodType>(
    request: ExtractionRequest<T>,
  ): Promise<ExtractionResponse> {
    const schema = toStrictJsonSchema(request.schema);
    const started = Date.now();

    if (!this.toolsRejected) {
      try {
        return await this.viaToolCall(request.prompt, schema, started);
      } catch (err) {
        // A tool-shaped rejection means this endpoint cannot do tool calling.
        // Anything else is a real failure and must not be masked by a retry
        // on a weaker path.
        if (!(err instanceof ToolsUnsupported)) throw err;
        this.toolsRejected = true;
      }
    }

    return this.viaJsonMode(request.prompt, schema, started);
  }

  /* ---------------- tool calling ---------------- */

  private async viaToolCall(
    prompt: string,
    schema: Record<string, unknown>,
    started: number,
  ): Promise<ExtractionResponse> {
    const body = await this.post({
      model: this.modelId,
      max_tokens: this.maxTokens,
      // Deterministic: this is extraction, not composition. Sampling variance
      // here shows up as the same transcript classifying differently between
      // passes, which reads to an operator as the system changing its mind.
      temperature: 0,
      messages: [{ role: "user", content: prompt }],
      tools: [
        {
          type: "function",
          function: {
            name: TOOL_NAME,
            description:
              "Record the structured incident data extracted from the transcript.",
            parameters: schema,
          },
        },
      ],
      // Forced, not merely offered. Left to its own judgement the model will
      // sometimes answer in prose instead of calling the tool.
      tool_choice: { type: "function", function: { name: TOOL_NAME } },
    });

    const call = body.choices?.[0]?.message?.tool_calls?.[0];
    const args = call?.function?.arguments;

    if (!args) {
      // The endpoint accepted the request but ignored the forced tool choice.
      // Fall through to JSON mode rather than failing the pass.
      throw new ToolsUnsupported("no tool call in response");
    }

    let parsed: unknown = null;
    try {
      parsed = JSON.parse(args);
    } catch {
      // Malformed arguments are a provider fault, not a schema one. Hand the
      // raw text to the service so field-level recovery can salvage it.
      return {
        parsed: null,
        rawText: args,
        structuredOutput: false,
        latencyMs: Date.now() - started,
        usage: this.usage(body),
      };
    }

    return {
      parsed,
      rawText: args,
      // Tool calling is the strongest path these endpoints offer. Not the
      // ~100% of true constrained decoding, but well above JSON mode.
      structuredOutput: true,
      latencyMs: Date.now() - started,
      usage: this.usage(body),
    };
  }

  /* ---------------- JSON mode ---------------- */

  private async viaJsonMode(
    prompt: string,
    schema: Record<string, unknown>,
    started: number,
  ): Promise<ExtractionResponse> {
    // DeepSeek requires the literal word "json" somewhere in the prompt before
    // it will honour json_object mode, and silently returns prose without it.
    // The schema is inlined because JSON mode enforces syntax only — the model
    // has to be *told* the shape, since nothing will constrain it to one.
    const instructed =
      `${prompt}\n\n` +
      `Reply with a single json object conforming exactly to this JSON Schema. ` +
      `No prose, no code fences, no commentary.\n\n` +
      `${JSON.stringify(schema)}`;

    const body = await this.post({
      model: this.modelId,
      max_tokens: this.maxTokens,
      temperature: 0,
      messages: [{ role: "user", content: instructed }],
      response_format: { type: "json_object" },
    });

    const content = body.choices?.[0]?.message?.content ?? null;

    return {
      parsed: null,
      // Deliberately left unparsed: the service's recovery path handles both
      // parsing and field-level salvage, and doing it twice in two places is
      // how the two implementations drift apart.
      rawText: content,
      // Valid JSON is not a valid schema. Saying otherwise here would hide the
      // real reliability of this path from every downstream metric.
      structuredOutput: false,
      latencyMs: Date.now() - started,
      usage: this.usage(body),
    };
  }

  /* ---------------- transport ---------------- */

  private async post(payload: unknown): Promise<ChatCompletionResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(this.endpoint, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.apiKey}`,
          ...this.config.headers,
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === "AbortError") {
        throw new ExtractionUnavailable(
          this.modelId,
          `timed out after ${this.timeoutMs}ms`,
          true,
        );
      }
      throw new ExtractionUnavailable(
        this.modelId,
        err instanceof Error ? err.message : String(err),
        true,
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();

    if (!response.ok) {
      const detail = extractErrorMessage(text);

      // Distinguish "this endpoint cannot do tools" from "this request was
      // wrong". Only the former justifies silently dropping to a weaker path.
      if (response.status === 400 && /tool|function/i.test(detail)) {
        throw new ToolsUnsupported(detail);
      }

      throw new ExtractionUnavailable(
        this.modelId,
        `HTTP ${response.status}: ${detail}`,
        response.status === 429 || response.status >= 500,
      );
    }

    let body: ChatCompletionResponse;
    try {
      body = JSON.parse(text) as ChatCompletionResponse;
    } catch {
      throw new ExtractionUnavailable(this.modelId, "response was not JSON", true);
    }

    // Some gateways return 200 with an error object in the body.
    if (body.error) {
      const message = body.error.message ?? "unspecified provider error";
      if (/tool|function/i.test(message)) throw new ToolsUnsupported(message);
      throw new ExtractionUnavailable(this.modelId, message, false);
    }

    return body;
  }

  private usage(body: ChatCompletionResponse) {
    return {
      input: body.usage?.prompt_tokens ?? 0,
      output: body.usage?.completion_tokens ?? 0,
    };
  }
}

/** Internal signal that this endpoint cannot do forced tool calling. */
class ToolsUnsupported extends Error {
  constructor(detail: string) {
    super(detail);
    this.name = "ToolsUnsupported";
  }
}

function extractErrorMessage(text: string): string {
  try {
    const body = JSON.parse(text) as { error?: { message?: string } | string };
    if (typeof body.error === "string") return body.error;
    return body.error?.message ?? text.slice(0, 200);
  } catch {
    return text.slice(0, 200);
  }
}
