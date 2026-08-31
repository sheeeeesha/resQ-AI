import { loadConfig } from "../config.js";
import { connect } from "./connect.js";
import { IncidentRepository, SYSTEM } from "../repository/incidents.js";
import { ConcurrencyConflict } from "../domain/errors.js";

/**
 * Verifies the M1 guarantees against a real database. Run with `npm run db:smoke`.
 *
 * The unit tests run on PGlite, which is single-connection — so they exercise
 * the version check but cannot exercise genuine write contention. This script
 * uses two real connections from the pool to test what PGlite structurally
 * cannot: that two writers racing on the same incident through a real network,
 * a real pooler and a real server produce exactly one winner.
 *
 * Note what this does and does not isolate. The guarantee has two layers — the
 * `FOR UPDATE` row lock and the `WHERE version = $expected` clause — and either
 * alone would produce the correct outcome here. The test asserts the outcome,
 * not which layer delivered it. That is the right assertion: the outcome is the
 * contract.
 *
 * This writes rows that cannot be removed: the audit log is append-only by
 * trigger, and incidents are referenced by it without a cascade. That is
 * correct for an audit-bearing system — retention works by purging content,
 * not by deleting history — but it means smoke rows are permanent. They are
 * prefixed SMOKE- so they are identifiable.
 */

function ok(label: string): void {
  console.log(`  PASS  ${label}`);
}
function bad(label: string, detail: string): never {
  console.error(`  FAIL  ${label}\n        ${detail}`);
  process.exitCode = 1;
  throw new Error(label);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const db = connect(config.DATABASE_URL);
  const repo = new IncidentRepository(db);

  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const reference = `SMOKE-${stamp}`;

  console.log(`Target: ${config.DATABASE_URL.replace(/:\/\/([^:]+):[^@]*@/, "://$1:****@")}`);
  console.log(`Reference: ${reference}\n`);

  try {
    /* ---- create ---- */
    const created = await repo.create(
      { reference, channel: "voice", primary_language: "hi" },
      SYSTEM,
    );
    if (created.version !== 0) bad("create", `expected version 0, got ${created.version}`);
    ok("incident created at version 0");

    const trail = await repo.auditTrail(created.incident_id);
    if (trail.length !== 1 || trail[0]!.type !== "incident_created") {
      bad("audit on create", `expected 1 incident_created event, got ${trail.length}`);
    }
    ok("creation wrote an audit event");

    /* ---- the real test: two writers, same version, two connections ---- */
    const results = await Promise.allSettled([
      repo.overrideField(
        created.incident_id,
        0,
        "priority",
        "P0_immediate",
        "wrong_severity",
        { id: "smoke-A" },
      ),
      repo.overrideField(
        created.incident_id,
        0,
        "priority",
        "P3_routine",
        "wrong_severity",
        { id: "smoke-B" },
      ),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const conflicts = results.filter(
      (r) => r.status === "rejected" && r.reason instanceof ConcurrencyConflict,
    );

    if (fulfilled.length !== 1 || conflicts.length !== 1) {
      const detail = results
        .map((r, i) =>
          r.status === "fulfilled"
            ? `  writer ${i}: succeeded`
            : `  writer ${i}: ${(r.reason as Error).name} — ${(r.reason as Error).message}`,
        )
        .join("\n");
      bad(
        "concurrent writers",
        `expected exactly one success and one ConcurrencyConflict.\n${detail}\n` +
          `        If BOTH succeeded, the connection pooler is not preserving\n` +
          `        session state — switch from the transaction pooler (6543) to\n` +
          `        the session pooler (5432).`,
      );
    }
    ok("two concurrent writers: one committed, one conflicted");

    /* ---- the loser's write left nothing behind ---- */
    const after = await repo.requireById(created.incident_id);
    if (after.version !== 1) {
      bad("version", `expected version 1 after one accepted write, got ${after.version}`);
    }
    ok("version incremented exactly once");

    const events = await repo.auditTrail(created.incident_id);
    const overrides = events.filter((e) => e.type === "field_overridden");
    if (overrides.length !== 1) {
      bad(
        "rolled-back audit",
        `expected 1 override event, found ${overrides.length} — ` +
          `the rejected write left an audit row behind`,
      );
    }
    ok("the rejected write left no audit event");

    /* ---- generated projection ---- */
    const winner = after.priority_code;
    if (winner !== "P0_immediate" && winner !== "P3_routine") {
      bad("generated column", `priority_code did not project: ${winner}`);
    }
    ok(`priority_code projected from JSONB (${winner})`);

    /* ---- append-only, enforced by the server ---- */
    try {
      await db.query("UPDATE audit_events SET actor = 'forged' WHERE incident_id = $1", [
        created.incident_id,
      ]);
      bad("append-only", "UPDATE on audit_events was allowed");
    } catch (err) {
      if (!/append-only/.test((err as Error).message)) {
        bad("append-only", `unexpected error: ${(err as Error).message}`);
      }
      ok("audit_events rejected UPDATE");
    }

    try {
      await db.query("DELETE FROM audit_events WHERE incident_id = $1", [
        created.incident_id,
      ]);
      bad("append-only", "DELETE on audit_events was allowed");
    } catch (err) {
      if (!/append-only/.test((err as Error).message)) {
        bad("append-only", `unexpected error: ${(err as Error).message}`);
      }
      ok("audit_events rejected DELETE");
    }

    /* ---- PostGIS, which PGlite cannot cover ---- */
    await db.query(
      "UPDATE incidents SET location_lat = 17.4401, location_lon = 78.3912 WHERE incident_id = $1",
      [created.incident_id],
    );
    const geo = await db.query<{ lat: number; lon: number; srid: number }>(
      `SELECT ST_Y(location_point::geometry) AS lat,
              ST_X(location_point::geometry) AS lon,
              ST_SRID(location_point::geometry) AS srid
         FROM incidents WHERE incident_id = $1`,
      [created.incident_id],
    );
    const point = geo[0];
    if (!point || Math.abs(point.lat - 17.4401) > 1e-6 || point.srid !== 4326) {
      bad("postgis", `location_point did not generate correctly: ${JSON.stringify(point)}`);
    }
    ok(`location_point generated from lat/lon (SRID ${point.srid})`);

    console.log(`\nAll checks passed.`);
    console.log(
      `\nLeft behind (permanent, by design): incident ${reference} ` +
        `and ${(await repo.auditTrail(created.incident_id)).length} audit events.`,
    );
  } finally {
    await db.close();
  }
}

main().catch((err: unknown) => {
  if (process.exitCode !== 1) {
    console.error(`\nUnexpected failure: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  }
});
