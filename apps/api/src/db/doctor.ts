import { loadConfig } from "../config.js";
import { connect } from "./connect.js";
import { hasSpatialSupport, listMigrations } from "./migrate.js";

/**
 * Reports what the configured database actually offers. Run with `npm run db:check`.
 *
 * Exists because the failure modes here are quiet ones: a database that is
 * reachable but missing PostGIS, or one that is a migration behind, both look
 * fine until something specific breaks much later. This says so up front.
 */
async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    console.error(
      "\nCopy apps/api/.env.example to apps/api/.env and fill in DATABASE_URL.",
    );
    process.exitCode = 1;
    return;
  }

  // Never print the password back to the terminal.
  const redacted = config.DATABASE_URL.replace(/:\/\/([^:]+):[^@]*@/, "://$1:****@");
  console.log(`target   ${redacted}`);

  const db = connect(config.DATABASE_URL);
  try {
    const [version] = await db.query<{ version: string }>("SELECT version()");
    console.log(`server   ${version?.version.split(",")[0] ?? "unknown"}`);

    const spatial = await hasSpatialSupport(db);
    console.log(`postgis  ${spatial ? "installed" : "NOT INSTALLED"}`);

    const files = await listMigrations();
    let applied: string[] = [];
    try {
      const rows = await db.query<{ name: string }>(
        "SELECT name FROM schema_migrations ORDER BY name",
      );
      applied = rows.map((r) => r.name);
    } catch {
      console.log("schema   no migrations table — run `npm run migrate`");
      return;
    }

    const pending = files.filter((f) => !applied.includes(f));
    console.log(`schema   ${applied.length}/${files.length} migrations applied`);
    for (const name of pending) console.log(`         pending: ${name}`);

    if (!spatial) {
      console.log(
        "\nPostGIS is absent. Migration 002 will be skipped and proximity " +
          "search stays unavailable. Everything else works.",
      );
    }
    if (pending.length === 0 && spatial) console.log("\nReady.");
  } catch (err) {
    console.error(`\nCould not reach the database: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  } finally {
    await db.close();
  }
}

void main();
