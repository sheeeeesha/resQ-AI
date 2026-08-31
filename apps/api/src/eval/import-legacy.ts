import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

import { detectLanguage } from "../language/detect.js";

/**
 * Turns exported legacy transcripts into evaluation case drafts.
 *
 * Run after `scripts/export-firebase.mjs`:
 *
 *   npm run eval:import -- --in data/legacy/call_transcripts.json
 *
 * ## Why this produces drafts and not cases
 *
 * An evaluation case needs a label — what a trained call-taker would decide.
 * Real transcripts arrive without one.
 *
 * The obvious shortcut is to label them with the model. That would be
 * circular: the harness would measure the model against its own opinions, and
 * every case it got wrong would be marked correct by definition. The number
 * that came out would look like accuracy and would be a measure of nothing.
 *
 * So this writes cases with `NEEDS_LABEL` in place of every expected value.
 * They are refused by the runner until a human fills them in — which is the
 * expensive part, and the part that makes the resulting set worth anything.
 *
 * ## Why the output is not committed
 *
 * These are real emergency calls. Under the DPDP Act the transcripts are
 * personal data, and the hand-written set in `cases.json` is committed. So the
 * output goes to a gitignored path by default, and the importer strips the
 * identifiers it can find. Neither of those makes a real transcript safe to
 * publish — they make it safe to work with locally.
 */

/** A record as the legacy export produces it. Field names varied over time. */
interface LegacyTranscript {
  id?: string;
  message?: string;
  text?: string;
  transcript?: string;
  speaker?: string;
  role?: string;
  timestamp?: string | number;
  callId?: string;
  call_id?: string;
  sessionId?: string;
  [key: string]: unknown;
}

const PLACEHOLDER = "NEEDS_LABEL";

/* ------------------------------------------------------------------ *
 * Redaction
 * ------------------------------------------------------------------ */

/**
 * Removes the identifiers a transcript carries in its text.
 *
 * Callers state their own phone numbers, and occasionally an Aadhaar or
 * vehicle registration. None of that is needed to evaluate a classifier, and
 * all of it raises the cost of the file leaking.
 *
 * The replacements keep the *shape* — a number is replaced by a marker, not
 * deleted — because "call me on [phone]" and "call me on" read differently to
 * a model, and the second would quietly change what the case tests.
 *
 * This is a reduction in exposure, not anonymisation. What remains is still a
 * real person describing a real emergency.
 */
export function redact(text: string): { text: string; removed: string[] } {
  const removed: string[] = [];

  const patterns: Array<[RegExp, string, string]> = [
    // Indian mobile numbers, with or without country code.
    [/(?:\+?91[-\s]?)?[6-9]\d{9}\b/g, "[phone]", "phone"],
    // Aadhaar, written as 4-4-4.
    [/\b\d{4}\s?\d{4}\s?\d{4}\b/g, "[id-number]", "id"],
    // Vehicle registration, e.g. MH12AB4471.
    [/\b[A-Z]{2}\s?\d{1,2}\s?[A-Z]{1,3}\s?\d{4}\b/g, "[vehicle]", "vehicle"],
    [/\b[\w.+-]+@[\w-]+\.[\w.]+\b/g, "[email]", "email"],
  ];

  let out = text;
  for (const [pattern, replacement, label] of patterns) {
    if (pattern.test(out)) {
      removed.push(label);
      out = out.replace(pattern, replacement);
    }
    pattern.lastIndex = 0;
  }

  return { text: out, removed: [...new Set(removed)] };
}

/* ------------------------------------------------------------------ *
 * Grouping
 * ------------------------------------------------------------------ */

function textOf(record: LegacyTranscript): string {
  return (record.message ?? record.text ?? record.transcript ?? "").trim();
}

function callOf(record: LegacyTranscript): string | null {
  return record.callId ?? record.call_id ?? record.sessionId ?? null;
}

/**
 * Normalises a speaker label.
 *
 * The same mapping the intake adapters apply, and for the same reason: the
 * prototype's own code filtered on the literal string "caller" against a feed
 * that may not have used it. An unrecognised label becomes `caller` here
 * rather than `unknown`, because in a legacy export every utterance came from
 * one side of a call and dropping them would empty the set.
 */
function speakerOf(record: LegacyTranscript): "caller" | "call_taker" {
  const raw = (record.speaker ?? record.role ?? "").toLowerCase();
  if (["call_taker", "operator", "agent", "assistant", "system"].includes(raw)) {
    return "call_taker";
  }
  return "caller";
}

/* ------------------------------------------------------------------ *
 * Import
 * ------------------------------------------------------------------ */

export interface DraftCase {
  id: string;
  tests: string;
  tags: string[];
  channel: "voice" | "whatsapp" | "sms" | "web";
  utterances: Array<{
    text: string;
    speaker: "caller" | "call_taker";
    language: string;
    asr_confidence: null;
  }>;
  expect: Record<string, unknown>;
  /** Notes for whoever labels this. Stripped once the case is complete. */
  _import: {
    source_ids: string[];
    redacted: string[];
    detected_language: string;
    utterance_count: number;
  };
}

export function toDrafts(records: LegacyTranscript[]): {
  drafts: DraftCase[];
  skipped: number;
} {
  /*
   * Grouped into calls where an identifier exists.
   *
   * A single utterance is rarely a useful case — the interesting behaviour is
   * how a classification develops across a conversation, and one line out of
   * context tests almost nothing. Records with no call identifier become
   * single-utterance drafts and are tagged so a labeller can see why they are
   * thin.
   */
  const calls = new Map<string, LegacyTranscript[]>();
  let orphans = 0;

  for (const record of records) {
    if (!textOf(record)) continue;
    const key = callOf(record) ?? `orphan-${orphans++}`;
    calls.set(key, [...(calls.get(key) ?? []), record]);
  }

  const drafts: DraftCase[] = [];
  let skipped = 0;

  for (const [callId, group] of calls) {
    const utterances: DraftCase["utterances"] = [];
    const redacted: string[] = [];

    for (const record of group) {
      const { text, removed } = redact(textOf(record));
      if (!text) continue;
      redacted.push(...removed);

      utterances.push({
        text,
        speaker: speakerOf(record),
        language: detectLanguage(text).language,
        // Legacy records carry no recognition confidence. Null is the honest
        // value; inventing one would feed the quality assessment a number
        // nobody measured.
        asr_confidence: null,
      });
    }

    // Nothing a caller said means nothing to classify.
    if (!utterances.some((u) => u.speaker === "caller")) {
      skipped += 1;
      continue;
    }

    const joined = utterances.map((u) => u.text).join(" ");
    const detected = detectLanguage(joined);

    // A stable, non-identifying id. Deriving it from the call identifier means
    // re-running the import does not renumber a set someone has been
    // labelling; hashing means the id does not carry the original reference.
    const id = `legacy-${createHash("sha256").update(callId).digest("hex").slice(0, 8)}`;

    drafts.push({
      id,
      tests: PLACEHOLDER,
      tags: [
        "legacy",
        "needs-label",
        detected.language,
        ...(detected.mixed ? ["code-switch"] : []),
        ...(utterances.length === 1 ? ["single-utterance"] : []),
      ],
      channel: "voice",
      utterances,
      expect: {
        incident_type: PLACEHOLDER,
        priority: PLACEHOLDER,
        required_agencies: [],
        required_escalations: [],
        life_threat: PLACEHOLDER,
        location_unresolvable: PLACEHOLDER,
      },
      _import: {
        source_ids: group.map((r) => r.id ?? "unknown"),
        redacted: [...new Set(redacted)],
        detected_language: detected.language,
        utterance_count: utterances.length,
      },
    });
  }

  return { drafts, skipped };
}

/* ------------------------------------------------------------------ *
 * Entry
 * ------------------------------------------------------------------ */

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string) => {
    const index = argv.indexOf(name);
    return index >= 0 ? (argv[index + 1] ?? null) : null;
  };

  const input = flag("--in") ?? "data/legacy/call_transcripts.json";
  // Gitignored by default. These are real emergency calls.
  const output = flag("--out") ?? "data/legacy/eval-drafts.json";

  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(input, "utf8"));
  } catch (err) {
    console.error(
      `Could not read ${input}.\n` +
        `Run the export first:\n` +
        `  GOOGLE_APPLICATION_CREDENTIALS=./service-account.json node scripts/export-firebase.mjs\n\n` +
        `${err instanceof Error ? err.message : err}`,
    );
    process.exitCode = 1;
    return;
  }

  const records = (Array.isArray(raw) ? raw : []) as LegacyTranscript[];
  if (records.length === 0) {
    console.error(`${input} contained no records.`);
    process.exitCode = 1;
    return;
  }

  const { drafts, skipped } = toDrafts(records);

  await mkdir(output.replace(/\/[^/]+$/, ""), { recursive: true });
  await writeFile(
    output,
    JSON.stringify(
      {
        name: "Legacy transcripts — UNLABELLED DRAFTS",
        version: "0.0.0",
        cases: drafts,
      },
      null,
      2,
    ),
  );

  const redactedCount = drafts.filter((d) => d._import.redacted.length > 0).length;
  const thin = drafts.filter((d) => d.tags.includes("single-utterance")).length;
  const languages = new Map<string, number>();
  for (const draft of drafts) {
    const key = draft._import.detected_language;
    languages.set(key, (languages.get(key) ?? 0) + 1);
  }

  console.log(`Read ${records.length} record(s) from ${input}`);
  console.log(`Wrote ${drafts.length} draft case(s) to ${output}\n`);
  console.log(`  skipped, nothing from the caller   ${skipped}`);
  console.log(`  had identifiers redacted           ${redactedCount}`);
  console.log(`  single utterance, thin as a case   ${thin}`);
  console.log(`\n  by detected language:`);
  for (const [language, count] of [...languages].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${language.padEnd(10)}${count}`);
  }

  console.log(`\nEvery expected value is "${PLACEHOLDER}". The runner refuses`);
  console.log(`the file until a person fills them in.`);
  console.log(`\nDo not label these with the model. The harness would then be`);
  console.log(`measuring the model against its own opinions, and every case it`);
  console.log(`got wrong would be marked correct by definition.`);
}

/*
 * Runs only when this file is the entry point, so the pure functions above
 * stay importable from a test.
 *
 * Compared as resolved URLs rather than by substring. A substring check on
 * "import-legacy" also matches `import-legacy.test.js`, so importing the
 * module from its own test ran the CLI — which then exited the test process
 * on a missing input file.
 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.stack : err);
    process.exitCode = 1;
  });
}
