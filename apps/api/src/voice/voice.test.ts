import test from "node:test";
import assert from "node:assert/strict";
import type { z } from "zod";
import { triageIsSettled, type TranscriptSegment } from "@resqai/schema";

import { createHarness, type Harness } from "../test-support/harness.js";
import { VoiceSession } from "./session.js";
import { ScriptedAsrProvider, type ScriptedUtterance } from "./asr.js";
import { TriageService } from "../extraction/triage.js";
import { ExtractionService } from "../extraction/service.js";
import { RuleBasedExtractionProvider } from "../extraction/rule-based.js";
import type {
  ExtractionProvider,
  ExtractionRequest,
  ExtractionResponse,
} from "../extraction/provider.js";

/**
 * The voice path, end to end, with no telephony account and no ASR
 * credentials. The scripted recogniser replays a call through the real
 * session, the real scheduler and the real repository.
 */

const CALL: ScriptedUtterance[] = [
  {
    text: "hello? hello? aag lag gayi hai",
    // A provisional result the engine later corrects — the shape a real
    // streaming recogniser produces.
    partial_first: "hello hello aag lag",
    confidence: 0.88,
    after_ms: 1200,
  },
  {
    text: "building mein aag hai, teesri manzil par",
    confidence: 0.91,
    after_ms: 2000,
  },
  {
    text: "do log phanse hain, ek bachcha bhi hai andar",
    confidence: 0.86,
    after_ms: 2000,
  },
];

/** Records what each tier was asked to classify, and when. */
class RecordingProvider implements ExtractionProvider {
  readonly modelId = "recording";
  readonly prompts: string[] = [];

  constructor(
    private readonly inner: ExtractionProvider,
    private readonly delayMs = 0,
  ) {}

  async extract<T extends z.ZodType>(
    request: ExtractionRequest<T>,
  ): Promise<ExtractionResponse> {
    this.prompts.push(request.prompt);
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    return this.inner.extract(request);
  }
}

/**
 * A triage provider that answers from keywords.
 *
 * The rule-based extractor produces the full grammar, not the triage one, so
 * the fast tier needs its own stand-in. This is deliberately trivial — the
 * tests are about the scheduler and the invariants, not about classification
 * quality, which M6 measures.
 */
class StubTriageProvider implements ExtractionProvider {
  readonly modelId = "stub-triage";
  calls = 0;

  constructor(
    private readonly answer: Record<string, unknown>,
    private readonly delayMs = 0,
  ) {}

  async extract<T extends z.ZodType>(
    _request: ExtractionRequest<T>,
  ): Promise<ExtractionResponse> {
    this.calls += 1;
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    return {
      parsed: this.answer,
      rawText: JSON.stringify(this.answer),
      structuredOutput: true,
      latencyMs: this.delayMs,
    };
  }
}

/**
 * The same call, replayed at real speech timing.
 *
 * Instant replay lands every utterance before the first pass returns, and
 * invariant 3 then correctly blocks the second — so testing the scheduler's
 * rhythm needs a script that actually takes time, as speech does.
 */
const SLOW_CALL: ScriptedUtterance[] = CALL.map((u) => ({ ...u, after_ms: 120 }));

const CONFIDENT_TRIAGE = {
  incident_type: "fire_structure",
  priority: "P0_immediate",
  life_threat: true,
  needs_human: false,
  confidence: 0.92,
};

async function withCall(
  fn: (ctx: {
    h: Harness;
    session: VoiceSession;
    triageProvider: StubTriageProvider;
    fullProvider: RecordingProvider;
  }) => Promise<void>,
  options: {
    script?: ScriptedUtterance[];
    triage?: Record<string, unknown>;
    triageDelayMs?: number;
    fullDelayMs?: number;
  } = {},
): Promise<void> {
  const h = await createHarness();
  try {
    const incident = await h.repo.create({
      reference: `TS-VOICE-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      channel: "voice",
    });

    const triageProvider = new StubTriageProvider(
      options.triage ?? CONFIDENT_TRIAGE,
      options.triageDelayMs ?? 0,
    );
    const fullProvider = new RecordingProvider(
      new RuleBasedExtractionProvider(),
      options.fullDelayMs ?? 0,
    );

    const session = new VoiceSession(
      {
        repo: h.repo,
        // Speed 0 replays instantly; a script with real timing needs speed 1
        // so the scheduler's rhythm is actually exercised.
        asr: new ScriptedAsrProvider(
          options.script ?? CALL,
          options.script === SLOW_CALL ? 1 : 0,
        ),
        triage: new TriageService(triageProvider),
        extraction: new ExtractionService({ provider: fullProvider }),
      },
      incident,
    );

    await session.start();
    await fn({ h, session, triageProvider, fullProvider });
  } finally {
    await h.close();
  }
}

/* ------------------------------------------------------------------ *
 * Invariant 1: extraction never runs on provisional text
 * ------------------------------------------------------------------ */

test("provisional text is never sent to extraction", async () => {
  await withCall(async ({ session, fullProvider, triageProvider: _t }) => {
    await session.end();

    // "hello hello aag lag" is the partial the engine later corrected. A
    // classification built on text the recogniser revises is worse than none.
    for (const prompt of fullProvider.prompts) {
      assert.ok(
        !prompt.includes("hello hello aag lag"),
        "a provisional utterance reached the extractor",
      );
    }
  });
});

test("provisional text is exposed for display and cleared when it settles", async () => {
  const h = await createHarness();
  try {
    const incident = await h.repo.create({ reference: "TS-PARTIAL", channel: "voice" });

    const session = new VoiceSession(
      {
        repo: h.repo,
        // Slow replay so the partial can be observed before its final arrives.
        asr: new ScriptedAsrProvider(
          [{ text: "aag lag gayi hai", partial_first: "aag lag", after_ms: 60 }],
          1,
        ),
        triage: new TriageService(new StubTriageProvider(CONFIDENT_TRIAGE)),
        extraction: new ExtractionService({ provider: new RuleBasedExtractionProvider() }),
      },
      incident,
    );

    await session.start();
    // Let the script play. With a real recogniser this is the caller speaking.
    await new Promise((resolve) => setTimeout(resolve, 400));
    await session.end();

    // Once the final arrives the partial is dropped — it would otherwise
    // linger in the console as text the caller never actually settled on.
    assert.equal(session.currentPartial, null);

    const stored = await h.repo.listSegments(incident.incident_id);
    assert.equal(stored.length, 1, "only the final is stored");
    assert.equal(stored[0]!.text, "aag lag gayi hai");
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------------------------ *
 * The two tiers
 * ------------------------------------------------------------------ */

test("the fast pass classifies before the full pass has finished", async () => {
  await withCall(
    async ({ h, session }) => {
      // Read the record while the call is still open. The closing full pass
      // legitimately owns the incident afterwards — it saw the whole call —
      // so the property under test is what a call-taker had *during* it.
      await new Promise((resolve) => setTimeout(resolve, 250));
      const during = await h.repo.requireById(session.incidentId);

      assert.equal(during.incident_type_code, "fire_structure");
      assert.equal(during.priority_code, "P0_immediate");

      const result = await session.end();
      assert.ok(result.triagePasses >= 1, "triage should have run");
      assert.ok(
        result.timeToTriageMs !== null,
        "time to first classification should be recorded",
      );
    },
    // The full pass is made slow on purpose, so anything classified came from
    // the fast tier.
    { fullDelayMs: 400 },
  );
});

test("the fast pass stops once the classification settles", async () => {
  await withCall(async ({ session, triageProvider }) => {
    await session.end();

    // Three utterances, but a confident answer arrives early. Continuing to
    // re-triage would pay for a call every few seconds until the caller hangs
    // up, and buy nothing the full pass is not already doing.
    assert.ok(
      triageProvider.calls <= 2,
      `triage ran ${triageProvider.calls} times after settling`,
    );
  });
});

test("an unsettled classification keeps the fast pass running", async () => {
  await withCall(
    async ({ session, triageProvider }) => {
      // Let the caller finish speaking. Ending immediately would cancel the
      // script, and the scheduler would never get a second utterance to react
      // to — testing nothing.
      await new Promise((resolve) => setTimeout(resolve, 600));
      await session.end();

      // Never settles, so every new utterance is another chance to resolve it.
      assert.ok(
        triageProvider.calls >= 2,
        `triage only ran ${triageProvider.calls} times while unsettled`,
      );
    },
    {
      script: SLOW_CALL,
      triage: {
        incident_type: "unclear",
        priority: "unclear",
        life_threat: false,
        needs_human: true,
        confidence: 0.3,
      },
    },
  );
});

test("triageIsSettled requires a resolved lane, priority and confidence", () => {
  assert.equal(triageIsSettled(null), false);
  assert.equal(
    triageIsSettled({ ...CONFIDENT_TRIAGE, incident_type: "unclear" } as never),
    false,
  );
  assert.equal(
    triageIsSettled({ ...CONFIDENT_TRIAGE, confidence: 0.5 } as never),
    false,
  );
  assert.equal(triageIsSettled(CONFIDENT_TRIAGE as never), true);
});

/* ------------------------------------------------------------------ *
 * Invariant 2: a slower pass never overwrites a newer one
 * ------------------------------------------------------------------ */

test("a full pass that saw less of the call is discarded, not applied", async () => {
  const warnings: string[] = [];
  const h = await createHarness();

  try {
    const incident = await h.repo.create({ reference: "TS-RACE", channel: "voice" });

    const session = new VoiceSession(
      {
        repo: h.repo,
        asr: new ScriptedAsrProvider(CALL, 0),
        triage: new TriageService(new StubTriageProvider(CONFIDENT_TRIAGE)),
        // Slow enough that a pass started early finishes after later
        // utterances have already been applied by the fast tier.
        extraction: new ExtractionService({
          provider: new RecordingProvider(new RuleBasedExtractionProvider(), 250),
        }),
        onWarning: (message) => warnings.push(message),
      },
      incident,
    );

    await session.start();
    const result = await session.end();

    const stored = await h.repo.requireById(result.incidentId);

    // Whatever the ordering, the record must reflect the whole call rather
    // than an early snapshot of it.
    assert.equal(stored.incident_type_code, "fire_structure");

    // If a stale pass was discarded, it said so rather than doing it silently.
    for (const warning of warnings.filter((w) => w.includes("discarded"))) {
      assert.match(warning, /already applied/);
    }
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------------------------ *
 * The transcript is the floor
 * ------------------------------------------------------------------ */

test("the transcript survives a total extraction failure", async () => {
  const h = await createHarness();

  try {
    const incident = await h.repo.create({ reference: "TS-ASRONLY", channel: "voice" });

    const exploding: ExtractionProvider = {
      modelId: "exploding",
      async extract() {
        throw new Error("model is on fire");
      },
    };

    const session = new VoiceSession(
      {
        repo: h.repo,
        asr: new ScriptedAsrProvider(CALL, 0),
        triage: new TriageService(exploding),
        extraction: new ExtractionService({ provider: exploding }),
      },
      incident,
    );

    await session.start();
    const result = await session.end();

    // Losing the caller's words because a classifier was unavailable is not an
    // acceptable failure. The transcript is stored independently of it.
    const stored = await h.repo.listSegments(result.incidentId);
    assert.equal(stored.length, CALL.length);
    assert.match(stored[0]!.text as string, /aag lag gayi hai/);
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------------------------ *
 * Audio quality
 * ------------------------------------------------------------------ */

test("poor audio escalates and is recorded as a quality rollup", async () => {
  await withCall(
    async ({ h, session }) => {
      const result = await session.end();
      const incident = await h.repo.requireById(result.incidentId);

      const quality = incident.transcript_quality as {
        mean_asr_confidence: number;
        degraded: boolean;
      } | null;

      assert.ok(quality, "quality should be recorded on the incident");
      assert.ok(quality!.degraded, "a call this poor should read as degraded");
      assert.ok(quality!.mean_asr_confidence < 0.65);

      // Poor audio is a condition a call-taker can act on — ask the caller to
      // move, or take the call over — rather than a mysterious absence of
      // extracted fields.
      assert.ok(incident.escalation_triggers.includes("asr_quality_poor"));
    },
    {
      script: [
        { text: "aag ... nahi sun", confidence: 0.41, after_ms: 500 },
        { text: "kuch samajh nahi", confidence: 0.38, after_ms: 500 },
      ],
    },
  );
});

test("confidence is stored per segment and never invented", async () => {
  await withCall(
    async ({ h, session }) => {
      const result = await session.end();
      const stored = await h.repo.listSegments(result.incidentId);

      assert.equal(stored[0]!.asr_confidence, 0.88);
      // Null where the engine reported nothing. A fabricated number would feed
      // the quality assessment and the escalation decision with a value
      // nobody measured.
      assert.equal(stored[1]!.asr_confidence, null);
    },
    {
      script: [
        { text: "aag lag gayi hai", confidence: 0.88, after_ms: 100 },
        { text: "jaldi aao", confidence: null, after_ms: 100 },
      ],
    },
  );
});

/* ------------------------------------------------------------------ *
 * Human decisions still win
 * ------------------------------------------------------------------ */

test("the fast pass does not overwrite what an operator already decided", async () => {
  const h = await createHarness();

  try {
    const incident = await h.repo.create({ reference: "TS-HUMAN", channel: "voice" });

    // The call-taker classifies it before the machine gets there.
    await h.repo.overrideField(
      incident.incident_id,
      incident.version,
      "incident_type",
      "crime_assault",
      "local_knowledge",
      { id: "op-voice" },
    );

    const session = new VoiceSession(
      {
        repo: h.repo,
        asr: new ScriptedAsrProvider(CALL, 0),
        triage: new TriageService(new StubTriageProvider(CONFIDENT_TRIAGE)),
        extraction: new ExtractionService({ provider: new RuleBasedExtractionProvider() }),
      },
      await h.repo.requireById(incident.incident_id),
    );

    await session.start();
    const result = await session.end();

    const stored = await h.repo.requireById(result.incidentId);
    const type = stored.fields.incident_type as Record<string, unknown>;

    // Being fast does not give a machine authority over a person who already
    // decided. The same rule the full pass follows.
    assert.equal(type.value, "crime_assault");
    assert.equal((type.review as Record<string, unknown>).state, "human_corrected");
  } finally {
    await h.close();
  }
});

/* ------------------------------------------------------------------ *
 * Call lifecycle
 * ------------------------------------------------------------------ */

test("the call records the timing the milestone is judged on", async () => {
  const h = await createHarness();

  try {
    const incident = await h.repo.create({ reference: "TS-TIMING", channel: "voice" });
    await h.repo.startCall({
      callId: "call-timing-1",
      incidentId: incident.incident_id,
      provider: "test",
    });

    const session = new VoiceSession(
      {
        repo: h.repo,
        asr: new ScriptedAsrProvider(CALL, 0),
        triage: new TriageService(new StubTriageProvider(CONFIDENT_TRIAGE)),
        extraction: new ExtractionService({ provider: new RuleBasedExtractionProvider() }),
      },
      incident,
    );

    await session.start();
    await session.end("caller_hung_up");

    const call = await h.repo.findCall("call-timing-1");
    assert.ok(call, "the call record should exist");
    assert.ok(call!.ended_at, "the call should be closed");
    assert.equal(call!.end_reason, "caller_hung_up");
    // Time to first usable classification is the number this whole milestone
    // is measured on; a system that cannot report it cannot be evaluated.
    assert.ok(Number(call!.first_triage_ms) >= 0);
  } finally {
    await h.close();
  }
});

test("the recogniser is recorded so a past transcript stays attributable", async () => {
  await withCall(async ({ h, session }) => {
    const result = await session.end();
    const incident = await h.repo.requireById(result.incidentId);
    assert.equal(incident.asr_engine, "scripted");
  });
});

/* ------------------------------------------------------------------ *
 * Rendering for the model
 * ------------------------------------------------------------------ */

test("low-confidence audio is flagged to the model rather than hidden", async () => {
  await withCall(
    async ({ session, fullProvider }) => {
      await session.end();

      const prompt = fullProvider.prompts.at(-1) ?? "";
      // Telling the model where the audio was bad is the cheapest accuracy
      // improvement available on this path.
      assert.match(prompt, /low-confidence audio/);
    },
    {
      script: [
        { text: "aag lag gayi hai", confidence: 0.35, after_ms: 100 },
        { text: "teesri manzil", confidence: 0.95, after_ms: 100 },
      ],
    },
  );
});
