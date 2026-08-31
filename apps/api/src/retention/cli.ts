import { loadConfig } from "../config.js";
import { connect } from "../db/connect.js";
import { RetentionService } from "./purge.js";

/**
 * The retention CLI. `npm run retention -- [--sweep] [--actor <id>]`
 *
 * Reports by default and destroys only when asked. A compliance job that
 * purges the moment it is run is one nobody dares run to find out what it
 * would do, so the safe invocation is the default and the destructive one is
 * explicit.
 *
 * Intended to run on a schedule. Until then, running it by hand at least makes
 * the overdue count visible, which is the number an agency is accountable for.
 */
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const sweep = argv.includes("--sweep");
  const backfill = argv.includes("--backfill");
  const actorIndex = argv.indexOf("--actor");
  const actorId = actorIndex >= 0 ? (argv[actorIndex + 1] ?? null) : null;

  const config = loadConfig();
  const db = connect(config.DATABASE_URL);
  const retention = new RetentionService(db);

  try {
    const status = await retention.status();

    console.log("Retention status");
    console.log(`  incidents stored        ${status.total}`);
    console.log(`  content purged          ${status.purged}`);
    console.log(`  under legal hold        ${status.held}`);
    console.log(`  past retention date     ${status.due}`);
    console.log(`  OVERDUE and unheld      ${status.overdue_unheld}`);

    // Surfaced prominently because it is the figure that makes every other
    // number on this report a lie by omission: an undated incident is never
    // selected by any sweep and is therefore kept forever.
    if (status.undated > 0) {
      console.log(
        `
  ${status.undated} incident(s) have NO retention date and will never be purged.`,
      );
      console.log("  Run with --backfill to date them from their received_at.");
    }

    if (backfill) {
      const dated = await retention.backfillUndated(config.RETENTION_DAYS);
      console.log(`
Dated ${dated} incident(s) from their received_at.`);
      if (!sweep) return;
    }

    if (!sweep) {
      const due = await retention.due();
      if (due.length > 0) {
        console.log(`\nWould purge ${due.length}:`);
        for (const candidate of due.slice(0, 20)) {
          console.log(`  ${candidate.reference}  due ${candidate.retain_until}`);
        }
        if (due.length > 20) console.log(`  … and ${due.length - 20} more`);
        console.log("\nRun again with --sweep to destroy this content.");
      } else {
        console.log("\nNothing is overdue.");
      }
      return;
    }

    if (!actorId) {
      // A purge with no attributable actor is a hole in the audit trail, and
      // the audit trail is the only thing that survives a purge.
      console.error("\n--sweep requires --actor <id>: purges are attributed.");
      process.exitCode = 1;
      return;
    }

    console.log(`\nPurging as ${actorId}…`);
    const result = await retention.sweep({ id: actorId });

    console.log(`  purged   ${result.purged.length}`);
    for (const reference of result.purged) console.log(`    ${reference}`);

    if (result.held.length > 0) {
      console.log(`  held     ${result.held.length} (past due, not purged)`);
      for (const held of result.held) {
        console.log(`    ${held.reference}  ${held.reason ?? "no reason recorded"}`);
      }
    }

    if (result.errors.length > 0) {
      console.log(`  errors   ${result.errors.length}`);
      for (const error of result.errors) {
        console.log(`    ${error.incident_id}  ${error.message}`);
      }
      process.exitCode = 1;
    }
  } finally {
    await db.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});
