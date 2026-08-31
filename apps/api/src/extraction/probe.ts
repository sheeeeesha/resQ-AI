import { IncidentExtraction, toStrictJsonSchema } from "@resqai/schema";
import { loadConfig } from "../config.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import { ExtractionService } from "./service.js";
import { buildExtractionPrompt } from "./prompt.js";
import type { TranscriptSegment } from "@resqai/schema";

/**
 * Probes an OpenAI-compatible endpoint. Run with `npm run extraction:probe`.
 *
 * Exists because the documentation for these gateways routinely disagrees with
 * their behaviour, and the disagreements matter here. Whether an endpoint
 * enforces a schema, merely guarantees valid JSON, or does neither is the
 * difference between the extraction contract holding and field-level recovery
 * carrying the whole system — and it is not something to take on trust.
 *
 * Reports four things:
 *   1. Is the endpoint reachable and the model available?
 *   2. Does forced tool calling work?  (95-99% schema-valid)
 *   3. Does json_schema work?          (~100%)
 *   4. Does json_object work?          (valid JSON, no schema guarantee)
 *
 * Then runs a real Hinglish extraction and shows what came back.
 */

const SAMPLE: TranscriptSegment[] = [
  {
    id: "s0",
    index: 0,
    speaker: "caller",
    text: "bhai jaldi aao! ORR ke paas Shiv Mandir ke peeche accident hua hai",
    text_en: null,
    language: "mixed",
    asr_confidence: null,
    start_ms: null,
    end_ms: null,
    received_at: "2026-08-30T09:00:00.000Z",
    is_final: true,
  },
  {
    id: "s1",
    index: 1,
    speaker: "caller",
    text: "do ya teen log ghayal hain, ek bachcha bhi hai, bahut khoon beh raha hai",
    text_en: null,
    language: "mixed",
    asr_confidence: null,
    start_ms: null,
    end_ms: null,
    received_at: "2026-08-30T09:00:12.000Z",
    is_final: true,
  },
];

interface Capability {
  name: string;
  supported: boolean | null;
  detail: string;
}

async function callRaw(
  baseUrl: string,
  apiKey: string,
  payload: unknown,
): Promise<{ status: number; body: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    });
    return { status: res.status, body: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  const config = loadConfig();

  const baseUrl = config.EXTRACTION_BASE_URL;
  const apiKey = config.EXTRACTION_API_KEY;
  const model = config.EXTRACTION_MODEL;

  if (!baseUrl || !apiKey) {
    console.error(
      "Set EXTRACTION_BASE_URL and EXTRACTION_API_KEY in apps/api/.env first.\n" +
        "For OpenCode, the base URL is the gateway root — no /chat/completions suffix.",
    );
    process.exitCode = 1;
    return;
  }

  console.log(`endpoint  ${baseUrl}`);
  console.log(`model     ${model}\n`);

  const schema = toStrictJsonSchema(IncidentExtraction);
  const capabilities: Capability[] = [];

  /* ---- 1. reachability ---- */
  try {
    const { status, body } = await callRaw(baseUrl, apiKey, {
      model,
      max_tokens: 16,
      messages: [{ role: "user", content: "Reply with the single word: ok" }],
    });

    if (status === 401 || status === 403) {
      console.error(`Authentication failed (HTTP ${status}). Check EXTRACTION_API_KEY.`);
      process.exitCode = 1;
      return;
    }
    if (status !== 200) {
      console.error(`Endpoint returned HTTP ${status}:\n${body.slice(0, 400)}`);
      process.exitCode = 1;
      return;
    }
    capabilities.push({ name: "reachable", supported: true, detail: "HTTP 200" });
  } catch (err) {
    console.error(`Cannot reach ${baseUrl}: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
    return;
  }

  /* ---- 2. forced tool calling ---- */
  {
    const { status, body } = await callRaw(baseUrl, apiKey, {
      model,
      max_tokens: 2000,
      temperature: 0,
      messages: [{ role: "user", content: "Call the tool with any valid values." }],
      tools: [
        {
          type: "function",
          function: { name: "record_incident", parameters: schema },
        },
      ],
      tool_choice: { type: "function", function: { name: "record_incident" } },
    });

    const hasCall =
      status === 200 && /"tool_calls"\s*:\s*\[/.test(body) && !/"tool_calls"\s*:\s*\[\s*\]/.test(body);

    capabilities.push({
      name: "forced tool calling",
      supported: hasCall,
      detail: hasCall
        ? "returned a tool call — 95-99% schema-valid, the preferred path"
        : status !== 200
          ? `HTTP ${status}: ${body.slice(0, 120)}`
          : "accepted the request but returned no tool call",
    });
  }

  /* ---- 3. json_schema ---- */
  {
    const { status, body } = await callRaw(baseUrl, apiKey, {
      model,
      max_tokens: 2000,
      messages: [{ role: "user", content: "Produce a json incident object." }],
      response_format: {
        type: "json_schema",
        json_schema: { name: "incident", schema, strict: true },
      },
    });

    capabilities.push({
      name: "json_schema",
      supported: status === 200,
      detail:
        status === 200
          ? "accepted — genuine constrained decoding, ~100% schema-valid"
          : `HTTP ${status}: ${body.slice(0, 120)}`,
    });
  }

  /* ---- 4. json_object ---- */
  {
    const { status, body } = await callRaw(baseUrl, apiKey, {
      model,
      max_tokens: 500,
      messages: [{ role: "user", content: 'Reply with a json object: {"ok": true}' }],
      response_format: { type: "json_object" },
    });

    capabilities.push({
      name: "json_object",
      supported: status === 200,
      detail:
        status === 200
          ? "accepted — valid JSON, but NO schema guarantee"
          : `HTTP ${status}: ${body.slice(0, 120)}`,
    });
  }

  console.log("capabilities");
  for (const c of capabilities) {
    const mark = c.supported === true ? "yes" : c.supported === false ? "NO " : "?  ";
    console.log(`  ${mark}  ${c.name.padEnd(20)} ${c.detail}`);
  }

  /* ---- 5. a real extraction ---- */
  console.log("\nrunning a real extraction on a Hinglish transcript…\n");
  console.log(
    buildExtractionPrompt({ segments: SAMPLE })
      .split("TRANSCRIPT")[1]
      ?.trim()
      .split("\n")
      .slice(0, 2)
      .map((l) => `  ${l}`)
      .join("\n"),
  );

  const provider = new OpenAICompatibleProvider({
    apiKey,
    baseUrl,
    model,
    preferJsonMode: config.EXTRACTION_PREFER_JSON_MODE,
  });

  const outcome = await new ExtractionService({ provider }).run(SAMPLE);

  console.log(`\n  latency            ${outcome.latencyMs}ms`);
  console.log(`  schema-constrained ${outcome.structuredOutput}`);
  console.log(`  degraded fields    ${outcome.degradedFields.length ? outcome.degradedFields.join(", ") : "none"}`);
  console.log(`  problems           ${outcome.problems.length ? "" : "none"}`);
  for (const p of outcome.problems) console.log(`    - ${p}`);

  if (outcome.error) {
    console.log(`  error              ${outcome.error}`);
    process.exitCode = 1;
    return;
  }

  const core = outcome.core!;
  console.log("\n  extracted:");
  for (const [name, value] of Object.entries(core)) {
    if (typeof value !== "object" || value === null || !("status" in value)) continue;
    const f = value as { value: unknown; status: string; confidence: number; evidence: string[] };
    console.log(
      `    ${name.padEnd(19)} ${JSON.stringify(f.value)}`.padEnd(64) +
        ` ${f.status} conf=${f.confidence} ev=${JSON.stringify(f.evidence)}`,
    );
  }
  console.log(`\n  summary: ${core.summary}`);
  console.log(`  escalation: ${core.escalation_triggers.join(", ") || "none"}`);

  console.log(
    outcome.structuredOutput
      ? "\nGood: this endpoint constrains generation. The contract holds at the provider."
      : "\nNote: this endpoint does NOT constrain generation. Valid JSON is not a valid " +
          "schema, so field-level recovery is load-bearing here rather than a safety net. " +
          "Expect a higher degraded-field rate and watch it in M6.",
  );
}

main().catch((err: unknown) => {
  console.error(`\n${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
});
