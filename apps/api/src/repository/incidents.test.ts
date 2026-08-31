import test from "node:test";
import assert from "node:assert/strict";

import { createHarness, testReference, type Harness } from "../test-support/harness.js";
import {
  IncidentRepository,
  REVIEWABLE_FIELDS,
  SYSTEM,
  type Actor,
} from "./incidents.js";
import {
  ConcurrencyConflict,
  IncidentNotFound,
  UnauditedMutation,
  UnknownField,
} from "../domain/errors.js";

const OPERATOR: Actor = { id: "op-114" };

async function withHarness(fn: (h: Harness) => Promise<void>): Promise<void> {
  const h = await createHarness();
  try {
    await fn(h);
  } finally {
    await h.close();
  }
}

async function newIncident(h: Harness) {
  return h.repo.create({ reference: testReference(), channel: "whatsapp" }, SYSTEM);
}

/* ------------------------------------------------------------------ *
 * Migrations
 * ------------------------------------------------------------------ */

test("migrations apply, and skip PostGIS where it is unavailable", async () => {
  await withHarness(async (h) => {
    const rows = await h.db.query<{ name: string }>(
      "SELECT name FROM schema_migrations ORDER BY name",
    );
    const names = rows.map((r) => r.name);

    assert.ok(names.includes("001_init.sql"));
    // PGlite has no PostGIS, so 002 is skipped rather than failing the run.
    assert.equal(names.includes("002_postgis.sql"), false);
  });
});

test("row level security is enabled on every table, default deny", async () => {
  await withHarness(async (h) => {
    const rows = await h.db.query<{ tablename: string; rowsecurity: boolean }>(
      `SELECT tablename, rowsecurity
         FROM pg_tables
        WHERE schemaname = 'public'
        ORDER BY tablename`,
    );

    assert.ok(rows.length >= 4, "expected the core tables to exist");
    for (const t of rows) {
      assert.equal(
        t.rowsecurity,
        true,
        `RLS must be enabled on ${t.tablename}`,
      );
    }

    /*
     * This originally asserted zero policies, as a proxy for "nothing is
     * exposed". Migration 011 replaced that posture with a stronger one: a
     * least-privilege application role with policies scoped to it, no DELETE
     * grant on anything holding incident data, and no grant or policy at all
     * for `anon` or `authenticated`.
     *
     * The proxy would now fail while the property it stood for is better than
     * it was, so the assertion moved to the property itself. The full posture
     * lives in `db/security.test.ts`; what is checked here is the part this
     * test was actually about — that no policy hands access to a Supabase
     * client role.
     */
    const exposed = await h.db.query<{ tablename: string }>(
      `SELECT tablename FROM pg_policies
        WHERE schemaname = 'public'
          AND ('anon' = ANY(roles) OR 'authenticated' = ANY(roles) OR 'public' = ANY(roles))`,
    );
    assert.deepEqual(
      exposed.map((r) => r.tablename),
      [],
      "no policy may grant access to a Supabase client role",
    );
  });
});

test("re-running migrations is a no-op", async () => {
  await withHarness(async (h) => {
    const { migrate } = await import("../db/migrate.js");
    const result = await migrate(h.db);
    assert.deepEqual(result.applied, []);
    assert.ok(result.alreadyCurrent.includes("001_init.sql"));
  });
});

/* ------------------------------------------------------------------ *
 * Exit criterion 1 — reads and writes go through the repository
 * ------------------------------------------------------------------ */

test("an incident can be created and read back", async () => {
  await withHarness(async (h) => {
    const created = await newIncident(h);

    assert.equal(created.status, "active_call");
    assert.equal(created.channel, "whatsapp");
    assert.equal(created.version, 0);
    assert.equal(created.degraded_mode, false);

    const fetched = await h.repo.requireById(created.incident_id);
    assert.equal(fetched.reference, created.reference);
  });
});

test("every reviewable field starts as an explicit not_stated proposal", async () => {
  await withHarness(async (h) => {
    const created = await newIncident(h);

    for (const name of REVIEWABLE_FIELDS) {
      const field = created.fields[name] as Record<string, unknown>;
      assert.ok(field, `${name} should be initialised`);
      assert.equal(field.value, null);
      // The distinction the prototype collapsed: not asked is not unknown.
      assert.equal(field.status, "not_stated");
      assert.equal(
        (field.review as Record<string, unknown>).state,
        "ai_proposed",
      );
    }
  });
});

test("a missing incident raises IncidentNotFound", async () => {
  await withHarness(async (h) => {
    await assert.rejects(
      () => h.repo.requireById("00000000-0000-0000-0000-000000000000"),
      IncidentNotFound,
    );
  });
});

test("an unknown field name is rejected before reaching the database", async () => {
  await withHarness(async (h) => {
    const inc = await newIncident(h);
    await assert.rejects(
      () => h.repo.confirmField(inc.incident_id, 0, "criticality", OPERATOR),
      UnknownField,
    );
  });
});

/* ------------------------------------------------------------------ *
 * Exit criterion 2 — every mutation writes an audit event
 * ------------------------------------------------------------------ */

test("creating an incident writes an audit event", async () => {
  await withHarness(async (h) => {
    const inc = await newIncident(h);
    const trail = await h.repo.auditTrail(inc.incident_id);

    assert.equal(trail.length, 1);
    assert.equal(trail[0]!.type, "incident_created");
  });
});

test("every mutating repository method writes an audit event", async () => {
  await withHarness(async (h) => {
    const inc = await newIncident(h);
    let version = inc.version;

    // Each entry exercises one public mutator. Adding a mutator without an
    // audit event makes this fail, which is the point.
    const mutators: Array<[string, () => Promise<{ version: number }>]> = [
      [
        "confirmField",
        () => h.repo.confirmField(inc.incident_id, version, "priority", OPERATOR),
      ],
      [
        "overrideField",
        () =>
          h.repo.overrideField(
            inc.incident_id,
            version,
            "priority",
            "P1_urgent",
            "wrong_severity",
            OPERATOR,
          ),
      ],
      [
        "setStatus",
        () =>
          h.repo.setStatus(
            inc.incident_id,
            version,
            "awaiting_confirmation",
            OPERATOR,
          ),
      ],
      [
        "escalate",
        () =>
          h.repo.escalate(
            inc.incident_id,
            version,
            ["low_confidence"],
            OPERATOR,
          ),
      ],
      [
        "setDegradedMode",
        () =>
          h.repo.setDegradedMode(
            inc.incident_id,
            version,
            true,
            "asr unavailable",
          ),
      ],
    ];

    let expected = 1; // the creation event
    for (const [name, run] of mutators) {
      const before = (await h.repo.auditTrail(inc.incident_id)).length;
      const updated = await run();
      version = updated.version;
      const after = (await h.repo.auditTrail(inc.incident_id)).length;

      assert.ok(
        after > before,
        `${name} must write at least one audit event`,
      );
      expected += 1;
    }

    assert.equal((await h.repo.auditTrail(inc.incident_id)).length, expected);
  });
});

test("a mutation producing no audit event is refused", async () => {
  await withHarness(async (h) => {
    const inc = await newIncident(h);

    // Reach past the public API to prove the guard is structural, not a
    // convention every future mutator has to remember.
    const apply = (
      h.repo as unknown as {
        apply: (
          id: string,
          v: number,
          a: Actor,
          m: () => { set: Record<string, unknown>; audits: unknown[] },
        ) => Promise<unknown>;
      }
    ).apply.bind(h.repo);

    await assert.rejects(
      () =>
        apply(inc.incident_id, 0, OPERATOR, () => ({
          set: { summary: "changed quietly" },
          audits: [],
        })),
      UnauditedMutation,
    );

    // And the write was rolled back with it.
    const after = await h.repo.requireById(inc.incident_id);
    assert.equal(after.summary, "");
    assert.equal(after.version, 0);
  });
});

test("the audit log is append-only, enforced by the database", async () => {
  await withHarness(async (h) => {
    const inc = await newIncident(h);

    await assert.rejects(
      () =>
        h.db.query("UPDATE audit_events SET actor = 'forged' WHERE incident_id = $1", [
          inc.incident_id,
        ]),
      /append-only/,
    );

    await assert.rejects(
      () =>
        h.db.query("DELETE FROM audit_events WHERE incident_id = $1", [
          inc.incident_id,
        ]),
      /append-only/,
    );

    // TRUNCATE bypasses row-level triggers, hence the separate statement guard.
    await assert.rejects(() => h.db.query("TRUNCATE audit_events"), /append-only/);

    assert.equal((await h.repo.auditTrail(inc.incident_id)).length, 1);
  });
});

test("an override records its reason and the value it replaced", async () => {
  await withHarness(async (h) => {
    const inc = await newIncident(h);

    const confirmed = await h.repo.overrideField(
      inc.incident_id,
      0,
      "incident_type",
      "road_traffic_accident",
      "wrong_classification",
      OPERATOR,
    );

    const field = confirmed.fields.incident_type as Record<string, unknown>;
    const review = field.review as Record<string, unknown>;

    assert.equal(field.value, "road_traffic_accident");
    assert.equal(field.confidence, 1);
    assert.equal(review.state, "human_corrected");
    assert.equal(review.override_reason, "wrong_classification");
    assert.equal(review.reviewed_by, "op-114");

    const trail = await h.repo.auditTrail(inc.incident_id);
    const override = trail.find((e) => e.type === "field_overridden")!;
    assert.equal(override.field_path, "incident_type");
    assert.equal(override.actor, "op-114");
    assert.deepEqual(override.detail, { reason: "wrong_classification" });
  });
});

/* ------------------------------------------------------------------ *
 * Exit criterion 3 — concurrent writes conflict
 * ------------------------------------------------------------------ */

test("a stale write is rejected rather than silently applied", async () => {
  await withHarness(async (h) => {
    const inc = await newIncident(h);

    // Two operators read version 0.
    const readByA = 0;
    const readByB = 0;

    await h.repo.overrideField(
      inc.incident_id,
      readByA,
      "priority",
      "P0_immediate",
      "wrong_severity",
      { id: "op-A" },
    );

    // B still holds the stale version and must not win.
    await assert.rejects(
      () =>
        h.repo.overrideField(
          inc.incident_id,
          readByB,
          "priority",
          "P3_routine",
          "wrong_severity",
          { id: "op-B" },
        ),
      ConcurrencyConflict,
    );

    const final = await h.repo.requireById(inc.incident_id);
    const priority = final.fields.priority as Record<string, unknown>;
    assert.equal(priority.value, "P0_immediate");
    assert.equal(final.version, 1);
  });
});

test("a rejected write leaves no audit event behind", async () => {
  await withHarness(async (h) => {
    const inc = await newIncident(h);
    await h.repo.setStatus(inc.incident_id, 0, "awaiting_confirmation", OPERATOR);

    const before = (await h.repo.auditTrail(inc.incident_id)).length;

    await assert.rejects(
      () => h.repo.setStatus(inc.incident_id, 0, "dispatched", OPERATOR),
      ConcurrencyConflict,
    );

    assert.equal((await h.repo.auditTrail(inc.incident_id)).length, before);
  });
});

test("version increments exactly once per accepted mutation", async () => {
  await withHarness(async (h) => {
    const inc = await newIncident(h);
    assert.equal(inc.version, 0);

    const v1 = await h.repo.setStatus(inc.incident_id, 0, "awaiting_confirmation", OPERATOR);
    assert.equal(v1.version, 1);

    const v2 = await h.repo.confirmField(inc.incident_id, 1, "priority", OPERATOR);
    assert.equal(v2.version, 2);
  });
});

/* ------------------------------------------------------------------ *
 * Escalation is one-way
 * ------------------------------------------------------------------ */

test("escalation triggers accumulate and cannot be cleared", async () => {
  await withHarness(async (h) => {
    const inc = await newIncident(h);

    const first = await h.repo.escalate(
      inc.incident_id,
      0,
      ["low_confidence"],
      SYSTEM,
    );
    assert.deepEqual(first.escalation_triggers, ["low_confidence"]);
    assert.ok(first.escalated_at);

    const second = await h.repo.escalate(
      inc.incident_id,
      first.version,
      ["caller_is_involved", "low_confidence"],
      SYSTEM,
    );

    // Deduplicated, and the original trigger survives.
    assert.deepEqual(
      [...second.escalation_triggers].sort(),
      ["caller_is_involved", "low_confidence"],
    );

    // The first escalation timestamp is preserved, not overwritten.
    assert.equal(
      new Date(second.escalated_at!).getTime(),
      new Date(first.escalated_at!).getTime(),
    );

    // There is no public way to clear a trigger.
    assert.equal(
      "clearEscalation" in (h.repo as unknown as Record<string, unknown>),
      false,
    );
  });
});

/* ------------------------------------------------------------------ *
 * Generated projections
 * ------------------------------------------------------------------ */

test("priority_code projects from the field envelope and cannot drift", async () => {
  await withHarness(async (h) => {
    const inc = await newIncident(h);
    assert.equal(inc.priority_code, null);

    const updated = await h.repo.overrideField(
      inc.incident_id,
      0,
      "priority",
      "P2_prompt",
      "wrong_severity",
      OPERATOR,
    );

    // The column is GENERATED from `fields`, so there is nothing to keep in sync.
    assert.equal(updated.priority_code, "P2_prompt");

    // Postgres refuses direct writes to a generated column outright.
    await assert.rejects(
      () =>
        h.db.query("UPDATE incidents SET priority_code = 'P0_immediate' WHERE incident_id = $1", [
          inc.incident_id,
        ]),
      /can only be updated to DEFAULT/,
    );
  });
});

test("the queue sorts most urgent first, unclassified last", async () => {
  await withHarness(async (h) => {
    const mk = async (priority: string | null) => {
      const inc = await h.repo.create(
        { reference: testReference(), channel: "voice" },
        SYSTEM,
      );
      if (priority) {
        await h.repo.overrideField(
          inc.incident_id,
          0,
          "priority",
          priority,
          "wrong_severity",
          OPERATOR,
        );
      }
      return inc.incident_id;
    };

    const routine = await mk("P3_routine");
    const immediate = await mk("P0_immediate");
    const unclassified = await mk(null);
    const urgent = await mk("P1_urgent");

    const queue = await h.repo.listQueue();
    const order = queue.map((r) => r.incident_id);

    assert.equal(order[0], immediate);
    assert.equal(order[1], urgent);
    assert.equal(order[2], routine);
    // Unclassified sorts last but is never dropped from the board.
    assert.equal(order[3], unclassified);
  });
});

test("resolved and cancelled incidents leave the queue", async () => {
  await withHarness(async (h) => {
    const inc = await newIncident(h);
    assert.equal((await h.repo.listQueue()).length, 1);

    await h.repo.setStatus(inc.incident_id, 0, "resolved", OPERATOR);
    assert.equal((await h.repo.listQueue()).length, 0);
  });
});

/* ------------------------------------------------------------------ *
 * Transcript append
 * ------------------------------------------------------------------ */

test("transcript segments append without racing", async () => {
  await withHarness(async (h) => {
    const inc = await newIncident(h);

    const seg = (idx: number, text: string) => ({
      index: idx,
      speaker: "caller" as const,
      text,
      text_en: null,
      language: "mixed" as const,
      asr_confidence: 0.8,
      start_ms: null,
      end_ms: null,
      received_at: new Date().toISOString(),
      is_final: true,
    });

    // Concurrent appends. The prototype's read-modify-write over one document
    // lost messages here; independent rows do not.
    await Promise.all([
      h.repo.appendSegment(inc.incident_id, seg(0, "accident hua hai")),
      h.repo.appendSegment(inc.incident_id, seg(1, "do log ghayal hain")),
      h.repo.appendSegment(inc.incident_id, seg(2, "ORR ke paas")),
    ]);

    const segments = await h.repo.listSegments(inc.incident_id);
    assert.equal(segments.length, 3);
    assert.deepEqual(
      segments.map((s) => s.idx),
      [0, 1, 2],
    );
  });
});

test("a provisional segment is revised by its final version, but a final one is not", async () => {
  await withHarness(async (h) => {
    const inc = await newIncident(h);
    const base = {
      index: 0,
      speaker: "caller" as const,
      text_en: null,
      language: "hi" as const,
      asr_confidence: 0.5,
      start_ms: null,
      end_ms: null,
      received_at: new Date().toISOString(),
    };

    await h.repo.appendSegment(inc.incident_id, {
      ...base,
      text: "aag lagi",
      is_final: false,
    });
    await h.repo.appendSegment(inc.incident_id, {
      ...base,
      text: "aag lagi hai teesri manzil par",
      is_final: true,
      asr_confidence: 0.9,
    });

    let segments = await h.repo.listSegments(inc.incident_id);
    assert.equal(segments.length, 1);
    assert.equal(segments[0]!.text, "aag lagi hai teesri manzil par");
    assert.equal(segments[0]!.is_final, true);

    // A settled segment is not rewritten by a late-arriving duplicate.
    await h.repo.appendSegment(inc.incident_id, {
      ...base,
      text: "GARBLED",
      is_final: true,
    });
    segments = await h.repo.listSegments(inc.incident_id);
    assert.equal(segments[0]!.text, "aag lagi hai teesri manzil par");
  });
});

/* ------------------------------------------------------------------ *
 * Constraints
 * ------------------------------------------------------------------ */

test("the database rejects impossible coordinates and half-set locations", async () => {
  await withHarness(async (h) => {
    const inc = await newIncident(h);

    await assert.rejects(
      () =>
        h.db.query("UPDATE incidents SET location_lat = 91, location_lon = 78 WHERE incident_id = $1", [
          inc.incident_id,
        ]),
      /incidents_lat_range/,
    );

    // A latitude with no longitude is not a location.
    await assert.rejects(
      () =>
        h.db.query("UPDATE incidents SET location_lat = 17.4 WHERE incident_id = $1", [
          inc.incident_id,
        ]),
      /incidents_latlon_together/,
    );
  });
});

test("an incident cannot be its own duplicate", async () => {
  await withHarness(async (h) => {
    const inc = await newIncident(h);
    await assert.rejects(
      () =>
        h.db.query(
          "UPDATE incidents SET possible_duplicate_of = incident_id WHERE incident_id = $1",
          [inc.incident_id],
        ),
      /incidents_no_self_duplicate/,
    );
  });
});

test("references are unique", async () => {
  await withHarness(async (h) => {
    const ref = testReference();
    await h.repo.create({ reference: ref, channel: "voice" }, SYSTEM);
    await assert.rejects(
      () => h.repo.create({ reference: ref, channel: "voice" }, SYSTEM),
      /unique|duplicate key/i,
    );
  });
});

/* ------------------------------------------------------------------ *
 * Data protection defaults
 * ------------------------------------------------------------------ */

test("training use defaults to off", async () => {
  await withHarness(async (h) => {
    const inc = await newIncident(h);
    const dh = inc.data_handling as Record<string, unknown>;

    assert.equal(dh.may_use_for_training, false);
    assert.equal(dh.content_purged, false);
  });
});

test("the raw caller number is never stored", async () => {
  await withHarness(async (h) => {
    const inc = await h.repo.create(
      {
        reference: testReference(),
        channel: "voice",
        caller_number_hash: "sha256:9f2c…",
      },
      SYSTEM,
    );

    assert.equal(inc.caller_number_hash, "sha256:9f2c…");
    const cols = await h.db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'incidents' AND column_name LIKE '%number%'`,
    );
    assert.deepEqual(
      cols.map((c) => c.column_name),
      ["caller_number_hash"],
    );
  });
});
