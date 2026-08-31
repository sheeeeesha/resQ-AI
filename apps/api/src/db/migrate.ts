import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { Db } from "./driver.js";

/**
 * Migration runner.
 *
 * Plain `.sql` files applied in filename order, each inside its own
 * transaction, recorded with a checksum. No DSL and no rollback support:
 * forward-only migrations with an immutable history are easier to reason about
 * under pressure than a reversible chain nobody has ever run backwards.
 *
 * A file may declare `-- @requires-extension <name>`. If the extension is not
 * available on the server, the migration is skipped rather than failing —
 * which is how the PostGIS layer stays optional in environments that cannot
 * provide it, without the rest of the schema diverging.
 */

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

const REQUIRES_EXTENSION = /^--\s*@requires-extension\s+(\w+)\s*$/m;

export interface MigrationRecord {
  name: string;
  checksum: string;
  applied_at: string;
}

export interface MigrateResult {
  applied: string[];
  skipped: Array<{ name: string; reason: string }>;
  alreadyCurrent: string[];
}

function checksum(sql: string): string {
  // Normalise line endings so a Windows checkout and a Linux CI run agree.
  return createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex");
}

async function ensureMigrationTable(db: Db): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      checksum   text        NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

async function extensionAvailable(db: Db, name: string): Promise<boolean> {
  const rows = await db.query<{ count: string }>(
    "SELECT count(*)::text AS count FROM pg_available_extensions WHERE name = $1",
    [name],
  );
  return Number(rows[0]?.count ?? 0) > 0;
}

/** Migration files in application order. */
export async function listMigrations(): Promise<string[]> {
  const entries = await readdir(MIGRATIONS_DIR);
  return entries.filter((f) => f.endsWith(".sql")).sort();
}

export async function migrate(db: Db): Promise<MigrateResult> {
  await ensureMigrationTable(db);

  const applied = await db.query<MigrationRecord>(
    "SELECT name, checksum, applied_at FROM schema_migrations",
  );
  const appliedByName = new Map(applied.map((r) => [r.name, r]));

  const result: MigrateResult = { applied: [], skipped: [], alreadyCurrent: [] };

  for (const name of await listMigrations()) {
    const sql = await readFile(join(MIGRATIONS_DIR, name), "utf8");
    const sum = checksum(sql);
    const already = appliedByName.get(name);

    if (already) {
      // An edited migration means the database and the repository disagree
      // about what shape the schema is in. Fail loudly; this is not a
      // condition to paper over.
      if (already.checksum !== sum) {
        throw new Error(
          `Migration ${name} has changed since it was applied ` +
            `(recorded ${already.checksum.slice(0, 12)}, ` +
            `found ${sum.slice(0, 12)}). ` +
            `Add a new migration instead of editing an applied one.`,
        );
      }
      result.alreadyCurrent.push(name);
      continue;
    }

    const requires = REQUIRES_EXTENSION.exec(sql)?.[1];
    if (requires && !(await extensionAvailable(db, requires))) {
      result.skipped.push({
        name,
        reason: `extension "${requires}" is not available on this server`,
      });
      continue;
    }

    await db.transaction(async (tx) => {
      await tx.exec(sql);
      await tx.query(
        "INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)",
        [name, sum],
      );
    });

    result.applied.push(name);
  }

  return result;
}

/**
 * Whether the spatial layer is present.
 *
 * Callers that need proximity search consult this and degrade explicitly
 * rather than emitting SQL that will fail at runtime.
 */
export async function hasSpatialSupport(db: Db): Promise<boolean> {
  const rows = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM information_schema.columns
      WHERE table_name = 'incidents' AND column_name = 'location_point'`,
  );
  return Number(rows[0]?.count ?? 0) > 0;
}
