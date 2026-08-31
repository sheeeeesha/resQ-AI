import test from "node:test";
import assert from "node:assert/strict";
import type { z } from "zod";

import { FallbackExtractionProvider } from "./fallback.js";
import { RuleBasedExtractionProvider } from "./rule-based.js";
import {
  ExtractionUnavailable,
  type ExtractionProvider,
  type ExtractionResponse,
} from "./provider.js";

class Failing implements ExtractionProvider {
  readonly modelId = "primary";
  constructor(private readonly err: Error) {}
  async extract<T extends z.ZodType>(_r: {
    prompt: string;
    schema: T;
  }): Promise<ExtractionResponse> {
    throw this.err;
  }
}

class Working implements ExtractionProvider {
  readonly modelId = "primary";
  async extract<T extends z.ZodType>(_r: {
    prompt: string;
    schema: T;
  }): Promise<ExtractionResponse> {
    return { parsed: { ok: true }, rawText: null, structuredOutput: true, latencyMs: 1 };
  }
}

const REQUEST = { prompt: "[s0] caller: aag lag gayi hai", schema: {} as z.ZodType };

test("the primary is used when it works", async () => {
  const provider = new FallbackExtractionProvider(
    new Working(),
    new RuleBasedExtractionProvider(),
  );
  const response = await provider.extract(REQUEST);

  assert.deepEqual(response.parsed, { ok: true });
  assert.equal(provider.modelId, "primary");
});

test("a retryable failure falls through to the fallback", async () => {
  let reason: string | null = null;
  const provider = new FallbackExtractionProvider(
    new Failing(new ExtractionUnavailable("primary", "rate limited", true)),
    new RuleBasedExtractionProvider(),
    (r) => { reason = r; },
  );

  const response = await provider.extract(REQUEST);

  // Something beats nothing: a 429 should still route the incident to a lane.
  assert.ok(response.parsed);
  assert.match(reason!, /rate limited/);

  // And the record must say which provider actually answered.
  assert.equal(provider.modelId, "rule-based-v1");
});

test("a permanent failure is raised, not masked", async () => {
  const provider = new FallbackExtractionProvider(
    new Failing(new ExtractionUnavailable("primary", "authentication failed", false)),
    new RuleBasedExtractionProvider(),
  );

  // Quietly running on keyword matching for a week because a key was wrong is
  // exactly the silent degradation this system exists to avoid.
  await assert.rejects(() => provider.extract(REQUEST), /authentication failed/);
  assert.equal(provider.modelId, "primary");
});

test("an unexpected error is also raised rather than swallowed", async () => {
  const provider = new FallbackExtractionProvider(
    new Failing(new TypeError("boom")),
    new RuleBasedExtractionProvider(),
  );
  await assert.rejects(() => provider.extract(REQUEST), /boom/);
});

test("modelId tracks the most recent answerer across calls", async () => {
  const flaky = new Failing(new ExtractionUnavailable("primary", "timeout", true));
  const provider = new FallbackExtractionProvider(flaky, new RuleBasedExtractionProvider());

  await provider.extract(REQUEST);
  assert.equal(provider.modelId, "rule-based-v1");
});

test("the extraction pass is attributed to the provider that actually answered", async () => {
  const { ExtractionService } = await import("./service.js");

  const service = new ExtractionService({
    provider: new FallbackExtractionProvider(
      new Failing(new ExtractionUnavailable("primary", "rate limited", true)),
      new RuleBasedExtractionProvider(),
    ),
  });

  const outcome = await service.run([
    {
      id: "s0", index: 0, speaker: "caller",
      text: "aag lag gayi hai", text_en: null, language: "hi",
      asr_confidence: null, start_ms: null, end_ms: null,
      received_at: "2026-08-30T09:00:00.000Z", is_final: true,
    },
  ]);

  // Recording "primary" here would misattribute every degraded pass to the
  // model that was unavailable, and quietly corrupt the model-quality numbers
  // the M6 evaluation depends on.
  assert.equal(outcome.modelId, "rule-based-v1");
  assert.equal(outcome.core?.incident_type.value, "fire_structure");
});
