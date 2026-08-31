import { PGlite } from "@electric-sql/pglite";
import { pgliteDriver, type Db } from "../db/driver.js";
import { migrate } from "../db/migrate.js";
import { IncidentRepository } from "../repository/incidents.js";

/**
 * An in-process Postgres for tests.
 *
 * PGlite is real Postgres compiled to WebAssembly, so triggers, generated
 * columns, constraints and transaction semantics all behave as they will in
 * production. No server, no container, no fixtures to tear down — which is
 * what keeps the persistence layer actually tested rather than tested in
 * principle.
 *
 * The PostGIS migration is skipped automatically here (see `002_postgis.sql`),
 * because nothing in the foundation depends on it.
 */
export interface Harness {
  db: Db;
  repo: IncidentRepository;
  close(): Promise<void>;
}

export async function createHarness(): Promise<Harness> {
  const pglite = await PGlite.create();
  const db = pgliteDriver(pglite);
  await migrate(db);

  return {
    db,
    repo: new IncidentRepository(db),
    close: () => db.close(),
  };
}

let counter = 0;

/** A unique operator-facing reference, so tests never collide on the unique index. */
export function testReference(prefix = "TS"): string {
  counter += 1;
  return `${prefix}-2026-0830-${String(counter).padStart(5, "0")}`;
}
