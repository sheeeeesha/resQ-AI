import pg from "pg";
import { pgDriver, type Db } from "./driver.js";

/**
 * Connects to Postgres.
 *
 * Timestamps are returned as `Date`, JSONB as parsed objects — both are `pg`
 * defaults and the repository relies on them.
 */
export function connect(databaseUrl: string): Db {
  const pool = new pg.Pool({
    connectionString: databaseUrl,

    // Sized for a call-handling workload: many short transactions, no long
    // analytical queries.
    max: 10,
    idleTimeoutMillis: 30_000,

    // Fail fast rather than queueing behind an unreachable database. On this
    // path a slow failure is worse than a quick one — the console needs to
    // enter degraded mode, not hang.
    connectionTimeoutMillis: 5_000,
  });

  pool.on("error", (err: Error) => {
    // An idle client erroring is a connectivity event, not a request failure.
    // Log it; the pool replaces the client on its own.
    console.error("[db] idle client error:", err.message);
  });

  return pgDriver(pool);
}
