/**
 * A minimal database interface, implemented over both `pg` (production) and
 * PGlite (tests).
 *
 * Deliberately hand-written rather than reaching for a query builder. Two
 * reasons: the queries in this layer are simple and read better as SQL than as
 * a fluent chain, and PGlite has no first-party query-builder dialect — so an
 * abstraction here is what lets the whole persistence layer be tested with no
 * database server at all. A foundation whose tests need infrastructure is a
 * foundation that stops being tested.
 *
 * Both drivers use `$1`-style placeholders, so SQL is portable between them
 * without translation.
 */

export type Row = Record<string, unknown>;

export interface Db {
  /** Parameterised query. Never interpolate values into SQL. */
  query<T = Row>(sql: string, params?: readonly unknown[]): Promise<T[]>;

  /** Multi-statement DDL. No parameters; migrations only. */
  exec(sql: string): Promise<void>;

  /**
   * Runs `fn` inside a transaction, committing on return and rolling back on
   * throw. Nested calls join the outer transaction rather than opening a new
   * one, so a repository method can be composed without surprising anybody.
   */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;

  close(): Promise<void>;
}

/* ------------------------------------------------------------------ *
 * node-postgres
 * ------------------------------------------------------------------ */

interface PgQueryResult {
  rows: Row[];
}
interface PgClient {
  query(sql: string, params?: readonly unknown[]): Promise<PgQueryResult>;
  release(): void;
}
interface PgPool {
  query(sql: string, params?: readonly unknown[]): Promise<PgQueryResult>;
  connect(): Promise<PgClient>;
  end(): Promise<void>;
}

/** Wraps a `pg` Pool. Accepts the pool rather than a URL so callers own the lifecycle. */
export function pgDriver(pool: PgPool): Db {
  const fromClient = (client: PgClient, depth: number): Db => ({
    async query<T>(sql: string, params: readonly unknown[] = []) {
      const res = await client.query(sql, params);
      return res.rows as T[];
    },
    async exec(sql: string) {
      await client.query(sql);
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      // Already inside a transaction: use a savepoint so a failing inner block
      // does not silently abort the outer one.
      const name = `sp_${depth}`;
      await client.query(`SAVEPOINT ${name}`);
      try {
        const out = await fn(fromClient(client, depth + 1));
        await client.query(`RELEASE SAVEPOINT ${name}`);
        return out;
      } catch (err) {
        await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
        throw err;
      }
    },
    async close() {
      /* the outer driver owns the pool */
    },
  });

  return {
    async query<T>(sql: string, params: readonly unknown[] = []) {
      const res = await pool.query(sql, params);
      return res.rows as T[];
    },
    async exec(sql: string) {
      await pool.query(sql);
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const out = await fn(fromClient(client, 0));
        await client.query("COMMIT");
        return out;
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    },
    async close() {
      await pool.end();
    },
  };
}

/* ------------------------------------------------------------------ *
 * PGlite
 * ------------------------------------------------------------------ */

interface PgliteResult {
  rows: Row[];
}
interface PgliteLike {
  query(sql: string, params?: readonly unknown[]): Promise<PgliteResult>;
  exec(sql: string): Promise<unknown>;
  close(): Promise<void>;
}

/**
 * Wraps PGlite — real Postgres compiled to WebAssembly, running in-process.
 *
 * PGlite is single-connection, so transactions are serialised by construction.
 * That makes it unsuitable for testing genuine write contention; the
 * optimistic-concurrency tests therefore exercise the version check directly
 * by interleaving reads and writes, rather than relying on parallel clients.
 */
export function pgliteDriver(pglite: PgliteLike): Db {
  let depth = 0;

  const self: Db = {
    async query<T>(sql: string, params: readonly unknown[] = []) {
      const res = await pglite.query(sql, params);
      return res.rows as T[];
    },
    async exec(sql: string) {
      await pglite.exec(sql);
    },
    async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      const outermost = depth === 0;
      const name = `sp_${depth}`;
      depth += 1;
      try {
        await pglite.query(outermost ? "BEGIN" : `SAVEPOINT ${name}`);
        const out = await fn(self);
        await pglite.query(outermost ? "COMMIT" : `RELEASE SAVEPOINT ${name}`);
        return out;
      } catch (err) {
        await pglite.query(
          outermost ? "ROLLBACK" : `ROLLBACK TO SAVEPOINT ${name}`,
        );
        throw err;
      } finally {
        depth -= 1;
      }
    },
    async close() {
      await pglite.close();
    },
  };

  return self;
}
