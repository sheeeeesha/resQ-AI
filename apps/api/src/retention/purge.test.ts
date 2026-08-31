import test from "node:test";
import assert from "node:assert/strict";

import { createHarness, type Harness } from "../test-support/harness.js";
import { RetentionService } from "./purge.js";
import { SYSTEM } from "../repository/incidents.js";

/**
 * Retention and purge.
 *
 * The property under test throughout is the one the append-only audit log
 * forces: content is destroyed, records are not. After a purge an auditor must
 * still be able to establish that a call happened and what became of it, while
 * being unable to read a word the caller said.
 */

const OPERATOR = { id: "op-compliance" };
const DAY = 24 * 60 * 60 * 1000;

async function withRetention(
  fn: (ctx: { h: Harness; retention: RetentionService }) => Promise<void>,
): Promise<void> {
  const h = await createHarness();
  try {
    await fn({ h, retention: new RetentionService(h.db) });
  } finally {
    await h.close();
  }
}

/** An incident with a transcript, a caller hash and a due date in the past. */
async function seedExpired(h: Harness, reference: string, options: { minor?: boolean } = {}) {
  const incident = await h.repo.create({
    reference,
    channel: "whatsapp",
    caller_number_hash: "h1:deadbeefdeadbeefdeadbeefdeadbeef",
    data_handling: {
      involves_minor: options.minor ?? false,
      retain_until: new Date(Date.now() - DAY).toISOString(),
    },
  });

  await h.repo.appendSegment(incident.incident_id, {
    index: 0,
    speaker: "caller",
    text: "building mein aag lagi hai, mera number 9876543210 hai",
    text_en: "there is a fire in the building, my number is 9876543210",
    language: "hi",
    asr_confidence: null,
    start_ms: null,
    end_ms: null,
    received_at: new Date().toISOString(),
    is_final: true,
  });

  await h.repo.applyExtraction(incident.incident_id, incident.version, {
    fields: {
      ...incident.fields,
      incident_type: {
        value: "fire_structure",
        status: "extracted",
        confidence: 0.9,
        evidence: ["s0"],
        review: {
          state: "ai_proposed",
          reviewed_by: null,
          reviewed_at: null,
          override_reason: null,
          superseded_value: null,
        },
      },
    },
    summary: "Fire reported at a residential building.",
    overallConfidence: 0.9,
    escalationTriggers: ["life_threat_indicated"],
    degradedMode: false,
    updatedFields: ["incident_type"],
    preservedFields: [],
    contested: [],
    modelId: "test",
    passNumber: 1,
  });

  // The column is what the sweep filters on; the harness sets JSONB directly.
  await h.db.query(
    "UPDATE incidents SET retain_until = $2 WHERE incident_id = $1",
    [incident.incident_id, new Date(Date.now() - DAY).toISOString()],
  );

  return incident;
}

/* ------------------------------------------------------------------ *
 * Retention dates
 * ------------------------------------------------------------------ */

test("a minor's data gets a shorter window automatically", () => {
  const received = new Date("2026-01-01T00:00:00.000Z");

  const adult = RetentionService.retainUntil(received, 90, false);
  const minor = RetentionService.retainUntil(received, 90, true);

  assert.equal(adult, "2026-04-01T00:00:00.000Z");
  // Capped at 30 days. A policy that depends on an operator remembering to
  // shorten it is not a policy.
  assert.equal(minor, "2026-01-31T00:00:00.000Z");
});

test("a policy shorter than the minor cap is not lengthened by it", () => {
  const received = new Date("2026-01-01T00:00:00.000Z");
  // The cap is a ceiling, not a target.
  assert.equal(
    RetentionService.retainUntil(received, 7, true),
    RetentionService.retainUntil(received, 7, false),
  );
});

test("an incident is created with a retention date rather than without one", async () => {
  await withRetention(async ({ h }) => {
    const incident = await h.repo.create({
      reference: "TS-RETAIN-1",
      channel: "web",
      retentionDays: 90,
    });

    // An incident with no date is one nobody will ever purge, and nothing
    // would report that it had been missed.
    assert.ok(incident.retain_until, "retain_until should be set at intake");
    assert.ok(
      (incident.data_handling as { retain_until: string }).retain_until,
      "and mirrored into the contract's own representation",
    );
  });
});

/* ------------------------------------------------------------------ *
 * What purge destroys, and what it keeps
 * ------------------------------------------------------------------ */

test("purge destroys content and keeps the record", async () => {
  await withRetention(async ({ h, retention }) => {
    const incident = await seedExpired(h, "TS-PURGE-1");
    await retention.purge(incident.incident_id, OPERATOR);

    const after = await h.repo.requireById(incident.incident_id);

    // Gone: everything the caller said or that identifies them.
    assert.equal(after.summary, "");
    assert.equal(after.caller_number_hash, null);
    assert.deepEqual((after.location as { candidates: unknown[] }).candidates, []);
    assert.equal(after.transcript_quality, null);

    const segments = await h.repo.listSegments(incident.incident_id);
    assert.equal(segments[0]!.text, "");
    assert.equal(segments[0]!.text_en, null);

    // Kept: the operating agency's statistics, which contain nothing a caller
    // said about themselves.
    assert.equal(after.incident_type_code, "fire_structure");
    assert.equal(after.reference, "TS-PURGE-1");
    assert.ok(after.received_at);
    assert.ok(after.escalation_triggers.includes("life_threat_indicated"));

    assert.equal((after.data_handling as { content_purged: boolean }).content_purged, true);
    assert.ok(after.purged_at);
  });
});

test("the segment rows survive so the transcript length remains a statistic", async () => {
  await withRetention(async ({ h, retention }) => {
    const incident = await seedExpired(h, "TS-PURGE-2");
    await retention.purge(incident.incident_id, OPERATOR);

    const segments = await h.repo.listSegments(incident.incident_id);
    // How long the call was is operational data. What was said is not.
    assert.equal(segments.length, 1);
    assert.equal(segments[0]!.text, "");
  });
});

test("the extraction history keeps its attribution and loses its content", async () => {
  await withRetention(async ({ h, retention }) => {
    const incident = await seedExpired(h, "TS-PURGE-3");
    await h.repo.recordExtractionPass({
      incidentId: incident.incident_id,
      pass: 1,
      throughSegmentIndex: 0,
      result: { summary: "a fire at the caller's home" },
      modelId: "deepseek-v4-flash",
      promptVersion: "1.2.0",
      contractVersion: "1.0.0",
      latencyMs: 4200,
      problems: [],
      error: null,
    });

    await retention.purge(incident.incident_id, OPERATOR);

    const passes = await h.repo.listExtractionPasses(incident.incident_id);
    // Model quality reporting needs which model ran and how long it took;
    // it does not need what the model said about a specific caller.
    assert.equal(passes[0]!.model_id, "deepseek-v4-flash");
    assert.equal(passes[0]!.latency_ms, 4200);
  });
});

test("the purge is itself audited, permanently", async () => {
  await withRetention(async ({ h, retention }) => {
    const incident = await seedExpired(h, "TS-PURGE-4");
    await retention.purge(incident.incident_id, OPERATOR);

    const trail = await h.repo.auditTrail(incident.incident_id);
    const purge = trail.find((e) => e.type === "content_purged");

    // The trail states forever that a transcript existed and when it was
    // destroyed, even though the transcript is gone. That is what the
    // append-only log buys, and what a hard DELETE would take away.
    assert.ok(purge, "a purge event should exist");
    assert.equal(purge!.actor, "op-compliance");
    assert.equal((purge!.detail as { segments_destroyed: number }).segments_destroyed, 1);

    // And the events from before the purge are still there.
    assert.ok(trail.some((e) => e.type === "incident_created"));
  });
});

test("purging twice does not claim the content was destroyed twice", async () => {
  await withRetention(async ({ h, retention }) => {
    const incident = await seedExpired(h, "TS-PURGE-5");

    await retention.purge(incident.incident_id, OPERATOR);
    await retention.purge(incident.incident_id, OPERATOR);

    const trail = await h.repo.auditTrail(incident.incident_id);
    const events = trail.filter((e) => e.type === "content_purged");
    // A sweep that overlaps itself, or is re-run after a partial failure, must
    // be idempotent.
    assert.equal(events.length, 1);
  });
});

/* ------------------------------------------------------------------ *
 * Legal hold
 * ------------------------------------------------------------------ */

test("a hold prevents purge past the retention date", async () => {
  await withRetention(async ({ h, retention }) => {
    const incident = await seedExpired(h, "TS-HOLD-1");
    await retention.setLegalHold(
      incident.incident_id,
      true,
      OPERATOR,
      "under investigation, ref FIR/2026/1188",
    );

    await assert.rejects(
      () => retention.purge(incident.incident_id, OPERATOR),
      /legal hold/i,
    );

    const after = await h.repo.requireById(incident.incident_id);
    assert.notEqual(after.summary, "");
    assert.equal(after.purged_at, null);
  });
});

test("a sweep reports held incidents rather than silently skipping them", async () => {
  await withRetention(async ({ h, retention }) => {
    const held = await seedExpired(h, "TS-HOLD-2");
    const free = await seedExpired(h, "TS-SWEEP-1");

    await retention.setLegalHold(held.incident_id, true, OPERATOR, "court order");

    const result = await retention.sweep(OPERATOR);

    assert.deepEqual(result.purged, ["TS-SWEEP-1"]);
    // Silently skipping would make an overdue incident invisible, which is
    // exactly what a compliance report exists to prevent.
    assert.equal(result.held.length, 1);
    assert.equal(result.held[0]!.reference, "TS-HOLD-2");
    assert.match(result.held[0]!.reason!, /court order/);
  });
});

test("releasing a hold is audited as well as placing one", async () => {
  await withRetention(async ({ h, retention }) => {
    const incident = await seedExpired(h, "TS-HOLD-3");

    await retention.setLegalHold(incident.incident_id, true, OPERATOR, "investigation");
    await retention.setLegalHold(incident.incident_id, false, { id: "op-legal" }, null);

    const trail = await h.repo.auditTrail(incident.incident_id);
    // "Why does this still exist" and "who released it" are both questions
    // someone eventually asks.
    assert.ok(trail.some((e) => e.type === "legal_hold_placed"));

    const released = trail.find((e) => e.type === "legal_hold_released");
    assert.ok(released);
    assert.equal(released!.actor, "op-legal");

    // And it can now be purged.
    await retention.purge(incident.incident_id, OPERATOR);
    assert.ok((await h.repo.requireById(incident.incident_id)).purged_at);
  });
});

test("a hold on already-purged content is refused", async () => {
  await withRetention(async ({ h, retention }) => {
    const incident = await seedExpired(h, "TS-HOLD-4");
    await retention.purge(incident.incident_id, OPERATOR);

    // Accepting it would suggest to whoever reads the record later that
    // something had been preserved.
    await assert.rejects(
      () => retention.setLegalHold(incident.incident_id, true, OPERATOR, "too late"),
      /already been purged/i,
    );
  });
});

/* ------------------------------------------------------------------ *
 * Sweeps and reporting
 * ------------------------------------------------------------------ */

test("a sweep leaves incidents that are not yet due", async () => {
  await withRetention(async ({ h, retention }) => {
    await seedExpired(h, "TS-DUE-1");

    const future = await h.repo.create({
      reference: "TS-FUTURE-1",
      channel: "web",
      retentionDays: 90,
    });

    const result = await retention.sweep(OPERATOR);

    assert.deepEqual(result.purged, ["TS-DUE-1"]);
    assert.equal((await h.repo.requireById(future.incident_id)).purged_at, null);
  });
});

test("one failure does not stop the rest of a compliance sweep", async () => {
  await withRetention(async ({ h, retention }) => {
    await seedExpired(h, "TS-BATCH-1");
    await seedExpired(h, "TS-BATCH-2");
    await seedExpired(h, "TS-BATCH-3");

    const result = await retention.sweep(OPERATOR);
    assert.equal(result.purged.length, 3);
    assert.equal(result.errors.length, 0);
  });
});

test("status reports what is overdue and unheld, which is the compliance number", async () => {
  await withRetention(async ({ h, retention }) => {
    const overdue = await seedExpired(h, "TS-STATUS-1");
    const held = await seedExpired(h, "TS-STATUS-2");
    await h.repo.create({ reference: "TS-STATUS-3", channel: "web", retentionDays: 90 });

    await retention.setLegalHold(held.incident_id, true, OPERATOR, "investigation");

    const before = await retention.status();
    assert.equal(before.total, 3);
    assert.equal(before.purged, 0);
    assert.equal(before.held, 1);
    // Two are past due, but only one of them should have been purged already.
    assert.equal(before.due, 2);
    assert.equal(before.overdue_unheld, 1);

    await retention.purge(overdue.incident_id, OPERATOR);

    const after = await retention.status();
    assert.equal(after.purged, 1);
    assert.equal(after.overdue_unheld, 0);
  });
});

/* ------------------------------------------------------------------ *
 * Undated incidents
 * ------------------------------------------------------------------ */

test("an incident with no retention date is counted, not reported as compliant", async () => {
  await withRetention(async ({ h, retention }) => {
    // Created without a policy window — the path that produced every incident
    // in this project before retention existed.
    await h.repo.create({ reference: "TS-UNDATED-1", channel: "web" });

    const status = await retention.status();

    // Every other figure says compliant. It is not: this incident is never
    // selected by any sweep and would be kept forever.
    assert.equal(status.overdue_unheld, 0);
    assert.equal(status.due, 0);
    assert.equal(status.undated, 1);
  });
});

test("backfill dates from received_at, not from now", async () => {
  await withRetention(async ({ h, retention }) => {
    const received = new Date(Date.now() - 100 * DAY);
    const incident = await h.repo.create({
      reference: "TS-BACKFILL-1",
      channel: "web",
      received_at: received,
    });

    assert.equal(incident.retain_until, null);

    const dated = await retention.backfillUndated(90);
    assert.equal(dated, 1);

    const after = await h.repo.requireById(incident.incident_id);
    assert.ok(after.retain_until);

    // Dating from now would silently extend how long a hundred-day-old
    // incident is kept, turning a compliance fix into a retention extension.
    const expected = new Date(received.getTime() + 90 * DAY);
    assert.ok(
      Math.abs(after.retain_until!.getTime() - expected.getTime()) < 60_000,
      `expected ~${expected.toISOString()}, got ${after.retain_until!.toISOString()}`,
    );

    // And it is immediately due, which is the correct answer for something
    // received a hundred days ago under a ninety-day policy.
    assert.equal((await retention.status()).overdue_unheld, 1);
  });
});

test("backfill leaves already-dated and already-purged incidents alone", async () => {
  await withRetention(async ({ h, retention }) => {
    const dated = await h.repo.create({
      reference: "TS-BACKFILL-2",
      channel: "web",
      retentionDays: 30,
    });
    const original = (await h.repo.requireById(dated.incident_id)).retain_until;

    const purged = await seedExpired(h, "TS-BACKFILL-3");
    await retention.purge(purged.incident_id, OPERATOR);

    const changed = await retention.backfillUndated(90);
    assert.equal(changed, 0, "nothing should have needed dating");

    // A backfill that overwrote existing dates would extend a 30-day window
    // to 90 without anyone asking for it.
    assert.deepEqual(
      (await h.repo.requireById(dated.incident_id)).retain_until,
      original,
    );
  });
});

test("intake gives every incident a retention date", async () => {
  await withRetention(async ({ h, retention }) => {
    await h.repo.create({ reference: "TS-INTAKE-1", channel: "whatsapp", retentionDays: 90 });
    await h.repo.create({ reference: "TS-INTAKE-2", channel: "voice", retentionDays: 90 });

    assert.equal((await retention.status()).undated, 0);
  });
});
