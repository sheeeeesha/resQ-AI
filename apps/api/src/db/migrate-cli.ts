import { loadConfig } from "../config.js";
import { connect } from "./connect.js";
import { hasSpatialSupport, migrate } from "./migrate.js";

/**
 * Applies pending migrations. Run with `npm run migrate`.
 *
 * Reports skipped migrations explicitly rather than passing silently: a
 * production database quietly running without PostGIS would look identical to
 * a healthy one until the first proximity query failed.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const db = connect(config.DATABASE_URL);

  try {
    const result = await migrate(db);

    for (const name of result.applied) console.log(`applied  ${name}`);
    for (const name of result.alreadyCurrent) console.log(`current  ${name}`);
    for (const { name, reason } of result.skipped) {
      console.warn(`SKIPPED  ${name} — ${reason}`);
    }

    if (result.applied.length === 0 && result.skipped.length === 0) {
      console.log("Database is up to date.");
    }

    if (!(await hasSpatialSupport(db))) {
      console.warn(
        "\nWARNING: spatial support is not installed. Proximity search and " +
          "duplicate detection by location will be unavailable. Install the " +
          "PostGIS extension and re-run to enable them.",
      );
    }
  } finally {
    await db.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
