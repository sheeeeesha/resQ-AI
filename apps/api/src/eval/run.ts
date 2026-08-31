import { readFile, writeFile, mkdir } from "node:fs/promises";
import { EvalSet, type EvalCase, type TranscriptSegment } from "@resqai/schema";

import { loadConfig } from "../config.js";
import { ExtractionService } from "../extraction/service.js";
import { OpenAICompatibleProvider } from "../extraction/openai-compatible.js";
import { ClaudeExtractionProvider } from "../extraction/claude.js";
import { RuleBasedExtractionProvider } from "../extraction/rule-based.js";
import type { ExtractionProvider } from "../extraction/provider.js";
import { scoreCase, summarise, type CaseScore, type EvalSummary } from "./score.js";

/**
 * The evaluation runner. `npm run eval [-- --model X --model Y]`
 *
 * Turns the model choice into a measurement rather than an argument. Every
 * claim this project makes about accuracy or latency should come from here,
 * and a claim that cannot be reproduced by running this is not a claim worth
 * making.
 *
 * Runs entirely offline against the rule-based provider when no endpoint is
 * configured, which keeps the harness itself testable and gives a permanent
 * floor to compare real models against.
 */

interface RunOptions {
  models: string[];
  casesPath: string;
  outDir: string;
  /** Repeats per case, for separating model variance from endpoint variance. */
  repeats: number;
  tagFilter: string | null;
}

function parseArgs(argv: string[]): RunOptions {
  const models: string[] = [];
  let casesPath = "eval/cases.json";
  let outDir = "eval/results";
  let repeats = 1;
  let tagFilter: string | null = null;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--model") models.push(argv[++i] ?? "");
    else if (arg === "--cases") casesPath = argv[++i] ?? casesPath;
    else if (arg === "--out") outDir = argv[++i] ?? outDir;
    else if (arg === "--repeats") repeats = Number(argv[++i] ?? 1) || 1;
    else if (arg === "--tag") tagFilter = argv[++i] ?? null;
  }

  return { models: models.filter(Boolean), casesPath, outDir, repeats, tagFilter };
}

/** Turns a case into the transcript the extractor sees. */
function toSegments(testCase: EvalCase): TranscriptSegment[] {
  return testCase.utterances.map((utterance, index) => ({
    id: `s${index}`,
    index,
    speaker: utterance.speaker,
    text: utterance.text,
    text_en: null,
    language: utterance.language,
    asr_confidence: utterance.asr_confidence,
    start_ms: null,
    end_ms: null,
    // Fixed rather than `new Date()`, so two runs of the same set differ only
    // by what the model did.
    received_at: "2026-08-31T09:00:00.000Z",
    is_final: true,
  }));
}

function buildProvider(model: string, config: ReturnType<typeof loadConfig>): ExtractionProvider {
  if (model === "rule-based") return new RuleBasedExtractionProvider();

  if (model.startsWith("claude")) {
    return new ClaudeExtractionProvider({
      apiKey: config.ANTHROPIC_API_KEY,
      baseUrl: config.ANTHROPIC_BASE_URL,
      model,
      effort: config.EXTRACTION_EFFORT,
    });
  }

  if (!config.EXTRACTION_BASE_URL || !config.EXTRACTION_API_KEY) {
    throw new Error(
      `Model "${model}" needs EXTRACTION_BASE_URL and EXTRACTION_API_KEY.`,
    );
  }

  return new OpenAICompatibleProvider({
    apiKey: config.EXTRACTION_API_KEY,
    baseUrl: config.EXTRACTION_BASE_URL,
    model,
    // Generous, because a slow answer is a data point here rather than a
    // failure. The live path uses a much tighter ceiling.
    timeoutMs: 90_000,
  });
}

async function runModel(
  model: string,
  cases: EvalCase[],
  options: RunOptions,
  config: ReturnType<typeof loadConfig>,
): Promise<{ scores: CaseScore[]; summary: EvalSummary }> {
  const service = new ExtractionService({ provider: buildProvider(model, config) });
  const scores: CaseScore[] = [];

  for (const testCase of cases) {
    for (let attempt = 0; attempt < options.repeats; attempt += 1) {
      const segments = toSegments(testCase);
      const outcome = await service.run(segments);

      const score = scoreCase(testCase, outcome.core, {
        latencyMs: outcome.latencyMs,
        modelId: outcome.modelId,
        degradedFields: outcome.degradedFields,
        problems: outcome.problems,
        error: outcome.error,
        validSegmentIds: new Set(segments.map((s) => s.id)),
      });

      scores.push(score);

      const mark = score.missed_life_threat
        ? "MISSED LIFE THREAT"
        : score.type_correct && score.priority.distance === 0
          ? "ok"
          : score.priority.under_triaged
            ? "under-triaged"
            : "off";

      process.stdout.write(
        `  ${testCase.id.padEnd(28)}${String(score.latency_ms + "ms").padStart(8)}  ${mark}\n`,
      );
    }
  }

  return { scores, summary: summarise(scores, model) };
}

/* ------------------------------------------------------------------ *
 * Reporting
 * ------------------------------------------------------------------ */

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function report(summaries: EvalSummary[], scores: Map<string, CaseScore[]>): void {
  console.log("\n" + "=".repeat(78));
  console.log("SAFETY");
  console.log("=".repeat(78));
  console.log(
    "\nReported first and separately. A model with better overall accuracy that",
  );
  console.log("missed a life threat is not the better model.\n");

  console.log(
    "  " +
      "model".padEnd(24) +
      "missed LT".padStart(11) +
      "false LT".padStart(10) +
      "under".padStart(8) +
      "over".padStart(7) +
      "wgt err".padStart(9) +
      "esc recall".padStart(12),
  );
  for (const s of summaries) {
    console.log(
      "  " +
        s.model_id.padEnd(24) +
        String(s.missed_life_threats).padStart(11) +
        String(s.false_life_threats).padStart(10) +
        String(s.under_triaged).padStart(8) +
        String(s.over_triaged).padStart(7) +
        String(s.weighted_priority_error).padStart(9) +
        pct(s.escalation_recall).padStart(12),
    );
  }

  console.log("\n" + "=".repeat(78));
  console.log("ACCURACY");
  console.log("=".repeat(78) + "\n");
  console.log(
    "  " +
      "model".padEnd(24) +
      "type".padStart(9) +
      "priority".padStart(10) +
      "agency".padStart(9) +
      "verbatim".padStart(10) +
      "degraded".padStart(10) +
      "bad cites".padStart(11),
  );
  for (const s of summaries) {
    console.log(
      "  " +
        s.model_id.padEnd(24) +
        pct(s.type_accuracy).padStart(9) +
        pct(s.priority_exact).padStart(10) +
        pct(s.agency_recall).padStart(9) +
        pct(s.verbatim_preservation).padStart(10) +
        s.degraded_field_rate.toFixed(2).padStart(10) +
        String(s.invented_evidence_total).padStart(11),
    );
  }

  console.log("\n" + "=".repeat(78));
  console.log("LATENCY");
  console.log("=".repeat(78));
  console.log(
    "\nPercentiles, not means. An operating agency holds a system to its 95th",
  );
  console.log("percentile; a mean hides exactly the calls that went slowly.\n");

  console.log(
    "  " +
      "model".padEnd(24) +
      "p50".padStart(9) +
      "p95".padStart(9) +
      "p99".padStart(9) +
      "max".padStart(9) +
      "failures".padStart(10),
  );
  for (const s of summaries) {
    console.log(
      "  " +
        s.model_id.padEnd(24) +
        `${s.latency_p50}ms`.padStart(9) +
        `${s.latency_p95}ms`.padStart(9) +
        `${s.latency_p99}ms`.padStart(9) +
        `${s.latency_max}ms`.padStart(9) +
        String(s.failures).padStart(10),
    );
  }

  /*
   * Per-tag failures.
   *
   * The aggregate says how well a model does; this says what it is bad at,
   * which is the part that tells you what to fix. A model failing every
   * negation case and nothing else has a specific, addressable problem that an
   * overall accuracy figure would report as "88%".
   */
  console.log("\n" + "=".repeat(78));
  console.log("WHERE IT FAILS");
  console.log("=".repeat(78) + "\n");

  for (const [model, modelScores] of scores) {
    const byTag = new Map<string, { total: number; failed: number }>();

    for (const score of modelScores) {
      const failed =
        !score.type_correct ||
        score.priority.distance > 0 ||
        score.missed_life_threat ||
        score.missed_escalations.length > 0;

      for (const tag of score.tags) {
        const entry = byTag.get(tag) ?? { total: 0, failed: 0 };
        entry.total += 1;
        if (failed) entry.failed += 1;
        byTag.set(tag, entry);
      }
    }

    const weak = [...byTag.entries()]
      .filter(([, v]) => v.failed > 0)
      .sort((a, b) => b[1].failed / b[1].total - a[1].failed / a[1].total);

    console.log(`  ${model}`);
    if (weak.length === 0) {
      console.log("    no tag showed a failure\n");
      continue;
    }
    for (const [tag, v] of weak.slice(0, 8)) {
      console.log(`    ${tag.padEnd(20)} ${v.failed}/${v.total} failed`);
    }
    console.log();
  }
}

/* ------------------------------------------------------------------ *
 * Entry
 * ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const config = loadConfig();

  const raw = JSON.parse(await readFile(options.casesPath, "utf8")) as unknown;
  const parsed = EvalSet.safeParse(raw);

  if (!parsed.success) {
    console.error("The case set does not match the contract:\n");
    for (const issue of parsed.error.issues.slice(0, 10)) {
      console.error(`  ${issue.path.join(".")}: ${issue.message}`);
    }
    process.exitCode = 1;
    return;
  }

  const cases = options.tagFilter
    ? parsed.data.cases.filter((c) => c.tags.includes(options.tagFilter!))
    : parsed.data.cases;

  if (cases.length === 0) {
    console.error(`No cases matched tag "${options.tagFilter}".`);
    process.exitCode = 1;
    return;
  }

  // Always include the rule-based provider. It needs no credentials and gives
  // a permanent floor: a model that cannot beat keyword matching on this set
  // is not earning its cost.
  const models = options.models.length > 0 ? options.models : ["rule-based"];
  if (!models.includes("rule-based")) models.push("rule-based");

  console.log(`${parsed.data.name} v${parsed.data.version}`);
  console.log(`${cases.length} cases x ${options.repeats} repeat(s)\n`);

  const summaries: EvalSummary[] = [];
  const allScores = new Map<string, CaseScore[]>();

  for (const model of models) {
    console.log(`--- ${model} ---`);
    try {
      const { scores, summary } = await runModel(model, cases, options, config);
      summaries.push(summary);
      allScores.set(model, scores);
    } catch (err) {
      console.error(
        `  could not run: ${err instanceof Error ? err.message : err}\n`,
      );
    }
    console.log();
  }

  if (summaries.length === 0) {
    console.error("No model produced results.");
    process.exitCode = 1;
    return;
  }

  report(summaries, allScores);

  // Results are written as well as printed. A run nobody kept is a run nobody
  // can compare against after the next prompt change.
  await mkdir(options.outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = `${options.outDir}/${stamp}.json`;

  await writeFile(
    path,
    JSON.stringify(
      {
        set: { name: parsed.data.name, version: parsed.data.version },
        ran_at: new Date().toISOString(),
        repeats: options.repeats,
        summaries,
        scores: Object.fromEntries(allScores),
      },
      null,
      2,
    ),
  );

  console.log(`Written to ${path}\n`);

  /*
   * A missed life threat fails the run.
   *
   * This is what makes the harness a gate rather than a report. Wiring it into
   * CI means a prompt change that starts missing life threats cannot merge
   * quietly, which is the whole reason to have measured any of this.
   */
  const missed = summaries
    .filter((s) => s.model_id !== "rule-based")
    .reduce((acc, s) => acc + s.missed_life_threats, 0);

  if (missed > 0) {
    console.error(`FAILED: ${missed} missed life threat(s).\n`);
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});
