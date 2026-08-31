import test from "node:test";
import assert from "node:assert/strict";

import { createHarness, type Harness } from "../test-support/harness.js";
import { IntakePipeline } from "./intake.js";
import { ExtractionService } from "../extraction/service.js";
import { RuleBasedExtractionProvider } from "../extraction/rule-based.js";
import { SYSTEM } from "../repository/incidents.js";

/**
 * End-to-end intake, against a real Postgres (PGlite) with no external
 * services. A Hinglish WhatsApp message goes in; a stored, classified,
 * audited incident comes out.
 */

const SALT = "c".repeat(32);

async function withPipeline(
  fn: (ctx: { h: Harness; pipeline: IntakePipeline }) => Promise<void>,
): Promise<void> {
  const h = await createHarness();
  try {
    const pipeline = new IntakePipeline({
      repo: h.repo,
      extraction: new ExtractionService({ provider: new RuleBasedExtractionProvider() }),
      callerSalt: SALT,
      referencePrefix: "TS",
    });
    await fn({ h, pipeline });
  } finally {
    await h.close();
  }
}

let messageCounter = 0;
function whatsApp(text: string, from = "919876543210", id?: string) {
  messageCounter += 1;
  return {
    entry: [
      {
        changes: [
          {
            value: {
              messages: [
                {
                  id: id ?? `wamid.${messageCounter}`,
                  from,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: "text",
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

/* ------------------------------------------------------------------ *
 * Exit criterion: a Hinglish WhatsApp message becomes a stored incident
 * ------------------------------------------------------------------ */

test("a Hinglish WhatsApp message becomes a valid stored incident", async () => {
  await withPipeline(async ({ h, pipeline }) => {
    const [result] = await pipeline.handle(
      "whatsapp",
      whatsApp("bhai jaldi aao, aag lag gayi hai building mein, do log phanse hain"),
    );

    assert.ok(result);
    assert.equal(result.created, true);
    assert.equal(result.duplicate, false);
    assert.equal(result.language, "hi");
    assert.match(result.reference, /^TS-\d{8}-[0-9A-F]{6}$/);

    const incident = await h.repo.requireById(result.incidentId);

    assert.equal(incident.channel, "whatsapp");
    assert.equal(incident.status, "active_call");
    assert.equal(incident.incident_type_code, "fire_structure");
    assert.ok(incident.summary.length > 0);

    // The raw number is never stored.
    assert.match(incident.caller_number_hash!, /^h1:[0-9a-f]{32}$/);

    // The transcript is there, in the original script.
    const segments = await h.repo.listSegments(result.incidentId);
    assert.equal(segments.length, 1);
    assert.match(segments[0]!.text as string, /aag lag gayi/);
    assert.equal(segments[0]!.speaker, "caller");
    // Text channels have no recognition step, so no confidence to report.
    assert.equal(segments[0]!.asr_confidence, null);
  });
});

test("native Devanagari is stored in its original script", async () => {
  await withPipeline(async ({ h, pipeline }) => {
    const [result] = await pipeline.handle(
      "whatsapp",
      whatsApp("आग लग गई है, जल्दी मदद भेजो"),
    );

    const segments = await h.repo.listSegments(result!.incidentId);
    // Copying place names and phrasing verbatim is the whole point — a
    // translated-only record cannot be re-checked.
    assert.equal(segments[0]!.text, "आग लग गई है, जल्दी मदद भेजो");
  });
});

/* ------------------------------------------------------------------ *
 * Idempotency
 * ------------------------------------------------------------------ */

test("a redelivered webhook does not become a second segment", async () => {
  await withPipeline(async ({ h, pipeline }) => {
    const payload = whatsApp("accident hua hai ORR par", "919876543210", "wamid.RETRY");

    const [first] = await pipeline.handle("whatsapp", payload);
    const [second] = await pipeline.handle("whatsapp", payload);

    assert.equal(first!.duplicate, false);
    // WhatsApp retries until it gets a 2xx. Without this guard, one "there's a
    // fire" becomes three segments and reads to the extractor as emphasis.
    assert.equal(second!.duplicate, true);
    assert.equal(second!.incidentId, first!.incidentId);

    const segments = await h.repo.listSegments(first!.incidentId);
    assert.equal(segments.length, 1);
  });
});

/* ------------------------------------------------------------------ *
 * Conversation continuity
 * ------------------------------------------------------------------ */

test("a second message from the same number continues the same incident", async () => {
  await withPipeline(async ({ h, pipeline }) => {
    const [first] = await pipeline.handle("whatsapp", whatsApp("aag lagi hai"));
    const [second] = await pipeline.handle(
      "whatsapp",
      whatsApp("teesri manzil par, bachcha bhi hai andar"),
    );

    assert.equal(second!.created, false);
    assert.equal(second!.incidentId, first!.incidentId);

    const segments = await h.repo.listSegments(first!.incidentId);
    assert.equal(segments.length, 2);
    assert.deepEqual(segments.map((s) => s.idx), [0, 1]);

    // The later message adds a child, which must escalate.
    const incident = await h.repo.requireById(first!.incidentId);
    assert.ok(incident.escalation_triggers.includes("child_involved"));
  });
});

test("a different number starts a different incident", async () => {
  await withPipeline(async ({ pipeline }) => {
    const [a] = await pipeline.handle("whatsapp", whatsApp("aag lagi hai", "919876543210"));
    const [b] = await pipeline.handle("whatsapp", whatsApp("accident hua", "919111222333"));
    assert.notEqual(a!.incidentId, b!.incidentId);
  });
});

test("a resolved incident does not absorb the next message", async () => {
  await withPipeline(async ({ h, pipeline }) => {
    const [first] = await pipeline.handle("whatsapp", whatsApp("aag lagi hai"));
    const incident = await h.repo.requireById(first!.incidentId);
    await h.repo.setStatus(incident.incident_id, incident.version, "resolved", { id: "op-1" });

    const [second] = await pipeline.handle("whatsapp", whatsApp("ek aur baat"));

    assert.equal(second!.created, true);
    assert.notEqual(second!.incidentId, first!.incidentId);
  });
});

/* ------------------------------------------------------------------ *
 * The merge rule, end to end
 * ------------------------------------------------------------------ */

test("a later pass does not overwrite what an operator decided", async () => {
  await withPipeline(async ({ h, pipeline }) => {
    const [first] = await pipeline.handle("whatsapp", whatsApp("aag lag gayi hai"));

    // The operator disagrees and corrects the classification.
    let incident = await h.repo.requireById(first!.incidentId);
    await h.repo.overrideField(
      incident.incident_id,
      incident.version,
      "incident_type",
      "crime_assault",
      "wrong_classification",
      { id: "op-77" },
    );

    // A second message arrives that would classify as fire again.
    await pipeline.handle("whatsapp", whatsApp("aag bahut phail rahi hai"));

    incident = await h.repo.requireById(first!.incidentId);
    const type = incident.fields.incident_type as Record<string, unknown>;

    // The operator's decision stands.
    assert.equal(type.value, "crime_assault");
    assert.equal((type.review as Record<string, unknown>).state, "human_corrected");
    assert.equal(incident.incident_type_code, "crime_assault");

    // And the disagreement was recorded rather than discarded.
    const trail = await h.repo.auditTrail(incident.incident_id);
    const extractions = trail.filter((e) => e.type === "extraction_completed");
    const last = extractions[extractions.length - 1]!;
    assert.ok(
      (last.detail as Record<string, unknown>).contested as number,
      "the contested count should be recorded on the pass",
    );
  });
});

/* ------------------------------------------------------------------ *
 * Provenance
 * ------------------------------------------------------------------ */

test("every extracted field cites a real transcript segment", async () => {
  await withPipeline(async ({ h, pipeline }) => {
    const [result] = await pipeline.handle(
      "whatsapp",
      whatsApp("building mein aag lagi hai, bachcha andar phansa hai"),
    );

    const incident = await h.repo.requireById(result!.incidentId);
    const segments = await h.repo.listSegments(result!.incidentId);
    const validIds = new Set(segments.map((s) => `s${s.idx as number}`));

    for (const [name, raw] of Object.entries(incident.fields)) {
      const field = raw as { status: string; evidence: string[] };
      if (field.status !== "extracted") continue;

      for (const ref of field.evidence) {
        assert.ok(
          validIds.has(ref),
          `${name} cites ${ref}, which is not a segment of this transcript`,
        );
      }
    }
  });
});

test("each pass is recorded with the model and prompt that produced it", async () => {
  await withPipeline(async ({ h, pipeline }) => {
    const [result] = await pipeline.handle("whatsapp", whatsApp("aag lagi hai"));
    await pipeline.handle("whatsapp", whatsApp("aur bhi log hain"));

    const passes = await h.repo.listExtractionPasses(result!.incidentId);
    assert.equal(passes.length, 2);
    assert.deepEqual(passes.map((p) => p.pass), [1, 2]);

    for (const pass of passes) {
      // Without these, an audit trail can say what the system concluded but
      // not why, and cannot tell a model regression from a change in the calls.
      assert.equal(pass.model_id, "rule-based-v1");
      assert.ok(pass.prompt_version);
      assert.ok(pass.contract_version);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Escalation and degradation
 * ------------------------------------------------------------------ */

test("the rule-based fallback always escalates and marks the incident degraded", async () => {
  await withPipeline(async ({ h, pipeline }) => {
    const [result] = await pipeline.handle("whatsapp", whatsApp("aag lag gayi hai"));

    const incident = await h.repo.requireById(result!.incidentId);

    // Keyword matching is never permitted to be the last word.
    assert.ok(incident.escalation_triggers.includes("system_degraded"));
    assert.equal(result!.escalated, true);
  });
});

test("a self-reporting caller escalates", async () => {
  await withPipeline(async ({ h, pipeline }) => {
    const [result] = await pipeline.handle(
      "whatsapp",
      whatsApp("mujhe bachao, mera pair phansa hai, khoon beh raha hai"),
    );

    const incident = await h.repo.requireById(result!.incidentId);
    assert.ok(incident.escalation_triggers.includes("caller_is_involved"));
  });
});

test("escalation survives across passes", async () => {
  await withPipeline(async ({ h, pipeline }) => {
    const [first] = await pipeline.handle(
      "whatsapp",
      whatsApp("bachcha phansa hai andar"),
    );
    const afterFirst = await h.repo.requireById(first!.incidentId);
    assert.ok(afterFirst.escalation_triggers.includes("child_involved"));

    // A later, blander message must not clear the earlier concern.
    await pipeline.handle("whatsapp", whatsApp("theek hai"));

    const afterSecond = await h.repo.requireById(first!.incidentId);
    assert.ok(
      afterSecond.escalation_triggers.includes("child_involved"),
      "escalation is one-way",
    );
  });
});

/* ------------------------------------------------------------------ *
 * Other channels
 * ------------------------------------------------------------------ */

test("SMS and web submissions flow through the same pipeline", async () => {
  await withPipeline(async ({ h, pipeline }) => {
    const [sms] = await pipeline.handle("sms", {
      MessageSid: "SM-1",
      From: "+919812345678",
      Body: "road accident near the flyover, two people hurt",
    });
    assert.equal(sms!.created, true);

    const [web] = await pipeline.handle("web", {
      submissionId: "web-1",
      sessionId: "sess-1",
      message: "there is a fire in the market",
    });
    assert.equal(web!.created, true);

    const smsIncident = await h.repo.requireById(sms!.incidentId);
    assert.equal(smsIncident.channel, "sms");
    assert.equal(smsIncident.incident_type_code, "road_traffic_accident");

    const webIncident = await h.repo.requireById(web!.incidentId);
    assert.equal(webIncident.channel, "web");
  });
});

/* ------------------------------------------------------------------ *
 * Audit
 * ------------------------------------------------------------------ */

test("intake writes a complete audit trail", async () => {
  await withPipeline(async ({ h, pipeline }) => {
    const [result] = await pipeline.handle("whatsapp", whatsApp("aag lagi hai"));
    const trail = await h.repo.auditTrail(result!.incidentId);

    const types = trail.map((e) => e.type);
    assert.ok(types.includes("incident_created"));
    assert.ok(types.includes("extraction_completed"));
    assert.ok(types.includes("escalated_to_human"));

    // Ordering is by sequence, independent of clock skew.
    const seqs = trail.map((e) => Number(e.seq));
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  });
});

test("the queue shows the incident with a real priority", async () => {
  await withPipeline(async ({ h, pipeline }) => {
    await pipeline.handle("whatsapp", whatsApp("aag lagi hai, log phanse hain"));

    const queue = await h.repo.listQueue();
    assert.equal(queue.length, 1);
    assert.ok(queue[0]!.priority_code?.startsWith("P"));
  });
});
