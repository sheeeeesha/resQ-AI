import test from "node:test";
import assert from "node:assert/strict";

import { createHarness, type Harness } from "../test-support/harness.js";

/**
 * The database security posture.
 *
 * These assertions exist because the properties they check are invisible in
 * ordinary use and silent when they break. Nothing fails, no test goes red,
 * and a table simply becomes readable by whoever holds a Supabase anon key.
 */

/** Tables holding emergency data or the record of who touched it. */
const SENSITIVE_TABLES = [
  "incidents",
  "transcript_segments",
  "audit_events",
  "auth_events",
  "extraction_passes",
  "intake_messages",
  "response_units",
  "unit_recommendations",
  "voice_calls",
  "operators",
  "operator_sessions",
];

async function withDb(fn: (h: Harness) => Promise<void>): Promise<void> {
  const h = await createHarness();
  try {
    await fn(h);
  } finally {
    await h.close();
  }
}

test("row level security is on for every table holding emergency data", async () => {
  await withDb(async (h) => {
    const rows = await h.db.query<{ tablename: string; rowsecurity: boolean }>(
      `SELECT tablename, rowsecurity FROM pg_tables
        WHERE schemaname = 'public' AND tablename = ANY($1)`,
      [SENSITIVE_TABLES],
    );

    const found = new Set(rows.map((r) => r.tablename));

    for (const table of SENSITIVE_TABLES) {
      assert.ok(found.has(table), `${table} is missing from the schema`);
    }

    for (const row of rows) {
      // A table added without this is one where Supabase's default grants to
      // anon become live access, and nothing reports that it happened.
      assert.equal(row.rowsecurity, true, `RLS is off for ${row.tablename}`);
    }
  });
});

test("no policy grants anything to anon or authenticated", async () => {
  await withDb(async (h) => {
    const rows = await h.db.query<{ tablename: string; roles: string[] }>(
      `SELECT tablename, roles FROM pg_policies WHERE schemaname = 'public'`,
    );

    for (const row of rows) {
      const roles = row.roles ?? [];
      // The console holds no database credentials and reads through the API.
      // A policy naming either role would create a direct path that nothing
      // in this system needs.
      assert.ok(
        !roles.includes("anon") && !roles.includes("authenticated"),
        `${row.tablename} has a policy naming ${roles.join(", ")}`,
      );
    }
  });
});

test("the application role cannot delete an incident", async () => {
  await withDb(async (h) => {
    const rows = await h.db.query<{ table_name: string; privilege_type: string }>(
      `SELECT table_name, privilege_type
         FROM information_schema.role_table_grants
        WHERE grantee = 'resqai_api'
          AND table_schema = 'public'
          AND privilege_type = 'DELETE'`,
    );

    const deletable = rows.map((r) => r.table_name).sort();

    /*
     * Sessions are the only legitimate deletion: expired rows are swept so the
     * table does not grow without bound, and the record of who signed in when
     * lives in `auth_events`, which cannot be deleted at all.
     *
     * Everything else is closed by status or emptied by the retention purge,
     * which nulls content rather than removing rows. Withholding the grant
     * makes that a fact the database enforces rather than a property of our
     * code being correct.
     */
    assert.deepEqual(deletable, ["operator_sessions"]);
  });
});

test("the application role cannot amend either append-only log", async () => {
  await withDb(async (h) => {
    const rows = await h.db.query<{ table_name: string; privilege_type: string }>(
      `SELECT table_name, privilege_type
         FROM information_schema.role_table_grants
        WHERE grantee = 'resqai_api'
          AND table_schema = 'public'
          AND table_name IN ('audit_events', 'auth_events')
        ORDER BY table_name, privilege_type`,
    );

    const byTable = new Map<string, string[]>();
    for (const row of rows) {
      byTable.set(row.table_name, [
        ...(byTable.get(row.table_name) ?? []),
        row.privilege_type,
      ]);
    }

    for (const table of ["audit_events", "auth_events"]) {
      const privileges = (byTable.get(table) ?? []).sort();
      // Two independent mechanisms: the trigger refuses the operation, and the
      // grant means it never reaches the trigger. Either alone would do; both
      // means a mistake in one is not sufficient.
      assert.deepEqual(privileges, ["INSERT", "SELECT"], `${table} grants`);
    }
  });
});

test("the application role has the grants it actually needs", async () => {
  await withDb(async (h) => {
    const rows = await h.db.query<{ table_name: string }>(
      `SELECT DISTINCT table_name
         FROM information_schema.role_table_grants
        WHERE grantee = 'resqai_api' AND table_schema = 'public'`,
    );

    const granted = new Set(rows.map((r) => r.table_name));

    // Failing closed is the right direction, but only if someone notices. A
    // table the API cannot read produces a runtime error on the path that
    // needed it, which on this system might be a live call.
    for (const table of SENSITIVE_TABLES) {
      assert.ok(granted.has(table), `resqai_api has no grant on ${table}`);
    }
  });
});

test("every policy is scoped to the application role", async () => {
  await withDb(async (h) => {
    const rows = await h.db.query<{ tablename: string; roles: string[] }>(
      `SELECT tablename, roles FROM pg_policies WHERE schemaname = 'public'`,
    );

    assert.ok(rows.length > 0, "there should be policies for the API role");

    for (const row of rows) {
      // `PUBLIC` would grant to every role including anon, which is the
      // failure this whole arrangement exists to prevent.
      assert.ok(
        (row.roles ?? []).includes("resqai_api"),
        `${row.tablename} has a policy not scoped to resqai_api: ${(row.roles ?? []).join(", ")}`,
      );
    }
  });
});
