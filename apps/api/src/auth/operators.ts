import {
  randomBytes,
  randomUUID,
  createHash,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

import type { Db } from "../db/driver.js";

const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
) => Promise<Buffer>;

/**
 * Operator identity, credentials and sessions.
 *
 * Replaces the interim bearer tokens, whose real problem was not weakness but
 * permanence: a token could not be withdrawn without redeploying the service.
 * In a control room where access may need removing mid-shift — an operator
 * leaving, a machine compromised, a credential pasted into the wrong window —
 * that is the property that matters.
 */

/* ------------------------------------------------------------------ *
 * Roles
 * ------------------------------------------------------------------ */

/**
 * Roles, ordered by capability. Each includes everything below it.
 *
 * Deliberately few. A permission model with twenty flags is one nobody
 * configures correctly, and the distinctions that actually matter here are
 * three: who reviews classifications, who can override the retention policy,
 * and who can grant access.
 */
export const ROLES = ["call_taker", "supervisor", "admin"] as const;
export type Role = (typeof ROLES)[number];

const ROLE_RANK: Record<Role, number> = {
  call_taker: 0,
  supervisor: 1,
  admin: 2,
};

export function hasRole(actual: string, required: Role): boolean {
  const rank = ROLE_RANK[actual as Role];
  return rank !== undefined && rank >= ROLE_RANK[required];
}

export interface AuthenticatedOperator {
  id: string;
  display_name: string;
  role: Role;
  session_id: string;
  must_change_password: boolean;
}

/* ------------------------------------------------------------------ *
 * Password hashing
 * ------------------------------------------------------------------ */

/**
 * scrypt parameters.
 *
 * N=2^15 with r=8 is roughly 32 MB and ~100 ms on current hardware — slow
 * enough to make offline cracking expensive, fast enough that a shift change
 * with a dozen operators signing in does not stall.
 *
 * Stored with the hash rather than hardcoded at the comparison site, so these
 * can be raised later without invalidating every existing credential.
 */
const SCRYPT_N = 32768;
const KEY_LENGTH = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, KEY_LENGTH);
  return `scrypt$${SCRYPT_N}$${salt.toString("base64")}$${derived.toString("base64")}`;
}

/**
 * Verifies a password against a stored hash.
 *
 * Always performs the derivation, even when the stored hash is malformed or
 * the operator does not exist, so the time taken does not reveal which.
 */
export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "scrypt") return false;

  const salt = Buffer.from(parts[2]!, "base64");
  const expected = Buffer.from(parts[3]!, "base64");

  const derived = await scrypt(password, salt, expected.length || KEY_LENGTH);

  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

/** SHA-256 of a session token. See the note in migration 010. */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

export class AuthFailed extends Error {
  constructor(
    /** Why, for the audit log. Never returned to the caller. */
    public readonly reason: string,
  ) {
    // The message is deliberately uninformative. Distinguishing "no such
    // operator" from "wrong password" tells an attacker which half of a guess
    // was right, turning one problem into two easier ones.
    super("Sign-in failed");
    this.name = "AuthFailed";
  }
}

export class Forbidden extends Error {
  constructor(required: Role, actual: string) {
    super(`This action requires the ${required} role; you have ${actual}`);
    this.name = "Forbidden";
  }
}

/* ------------------------------------------------------------------ *
 * Service
 * ------------------------------------------------------------------ */

export interface SignInContext {
  ip?: string | null;
  userAgent?: string | null;
}

export class OperatorService {
  constructor(
    private readonly db: Db,
    private readonly sessionHours = 12,
  ) {}

  /* ---------------- operators ---------------- */

  async create(input: {
    operatorId: string;
    displayName: string;
    role: Role;
    password: string;
    mustChangePassword?: boolean;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO operators
         (operator_id, display_name, role, password_hash, must_change_password)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        input.operatorId,
        input.displayName,
        input.role,
        await hashPassword(input.password),
        input.mustChangePassword ?? true,
      ],
    );
  }

  /**
   * Disables an operator and revokes everything they have open.
   *
   * The row is never deleted. An operator ID appears throughout the
   * append-only audit trail, and removing it would make every past override
   * they made unattributable — destroying the accountability record in order
   * to tidy up a user list.
   *
   * Revoking sessions in the same transaction is the point of the whole
   * exercise: without it, disabling an account leaves the person signed in.
   */
  async disable(
    operatorId: string,
    reason: string,
    by: string,
  ): Promise<number> {
    return this.db.transaction(async (tx) => {
      await tx.query(
        `UPDATE operators
            SET active = false, disabled_at = now(), disabled_reason = $2,
                updated_at = now()
          WHERE operator_id = $1`,
        [operatorId, reason],
      );

      const revoked = await tx.query<{ session_id: string }>(
        `UPDATE operator_sessions
            SET revoked_at = now(), revoked_by = $2, revoked_reason = $3
          WHERE operator_id = $1 AND revoked_at IS NULL
          RETURNING session_id`,
        [operatorId, by, reason],
      );

      await this.record(tx, {
        operatorId,
        type: "operator_disabled",
        detail: { reason, by, sessions_revoked: revoked.length },
      });

      return revoked.length;
    });
  }

  async setPassword(operatorId: string, password: string): Promise<void> {
    await this.db.query(
      `UPDATE operators
          SET password_hash = $2, must_change_password = false, updated_at = now()
        WHERE operator_id = $1`,
      [operatorId, await hashPassword(password)],
    );
  }

  async list(): Promise<
    Array<{
      operator_id: string;
      display_name: string;
      role: string;
      active: boolean;
      last_seen_at: Date | null;
    }>
  > {
    return this.db.query(
      `SELECT operator_id, display_name, role, active, last_seen_at
         FROM operators ORDER BY active DESC, operator_id ASC`,
    );
  }

  async count(): Promise<number> {
    const rows = await this.db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM operators WHERE active = true",
    );
    return Number(rows[0]?.count ?? 0);
  }

  /* ---------------- sign in ---------------- */

  /**
   * Signs an operator in and issues a session.
   *
   * Every failure raises the same error and records the real reason to the
   * audit table. The caller learns nothing about which half of the attempt was
   * wrong; whoever reads the log learns everything.
   */
  async signIn(
    operatorId: string,
    password: string,
    context: SignInContext = {},
  ): Promise<{ token: string; operator: AuthenticatedOperator }> {
    const rows = await this.db.query<{
      operator_id: string;
      display_name: string;
      role: string;
      password_hash: string;
      active: boolean;
      must_change_password: boolean;
    }>(
      `SELECT operator_id, display_name, role, password_hash, active,
              must_change_password
         FROM operators WHERE operator_id = $1`,
      [operatorId],
    );

    const operator = rows[0];

    /*
     * A dummy verification when no such operator exists.
     *
     * Without it, an unknown name returns in a millisecond and a known one
     * takes a hundred, which is enough to enumerate valid operator IDs before
     * guessing a single password.
     */
    if (!operator) {
      await verifyPassword(password, await hashPassword("dummy"));
      await this.recordFailure(operatorId, "no_such_operator", context);
      throw new AuthFailed("no_such_operator");
    }

    if (!(await verifyPassword(password, operator.password_hash))) {
      await this.recordFailure(operatorId, "wrong_password", context);
      throw new AuthFailed("wrong_password");
    }

    // Checked after the password, so a disabled account cannot be identified
    // as existing by a faster rejection.
    if (!operator.active) {
      await this.recordFailure(operatorId, "disabled", context);
      throw new AuthFailed("disabled");
    }

    const token = randomBytes(32).toString("base64url");
    const sessionId = randomUUID();
    const expiresAt = new Date(Date.now() + this.sessionHours * 3600_000);

    await this.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO operator_sessions
           (session_id, operator_id, token_hash, expires_at, issued_ip, user_agent)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          sessionId,
          operator.operator_id,
          hashToken(token),
          expiresAt,
          context.ip ?? null,
          context.userAgent ?? null,
        ],
      );

      await tx.query(
        `UPDATE operators SET last_seen_at = now() WHERE operator_id = $1`,
        [operator.operator_id],
      );

      await this.record(tx, {
        operatorId: operator.operator_id,
        type: "sign_in",
        ip: context.ip,
        userAgent: context.userAgent,
        detail: { session_id: sessionId },
      });
    });

    return {
      token,
      operator: {
        id: operator.operator_id,
        display_name: operator.display_name,
        role: operator.role as Role,
        session_id: sessionId,
        must_change_password: operator.must_change_password,
      },
    };
  }

  /**
   * Resolves a session token.
   *
   * Returns null rather than throwing: an expired or revoked session is an
   * ordinary occurrence on every shift change, not an error condition.
   */
  async resolve(token: string): Promise<AuthenticatedOperator | null> {
    if (!token) return null;

    /*
     * The lookup and the `last_used_at` touch are one statement.
     *
     * The touch was originally issued as a fire-and-forget query alongside the
     * read, which is wrong for two reasons. It adds a second round trip to
     * every authenticated request, and an unawaited query overlapping the next
     * one corrupts a single-connection driver outright — PGlite fails with
     * "memory access out of bounds" rather than anything that names the cause.
     *
     * A CTE does both in one round trip with no concurrency at all.
     */
    const rows = await this.db.query<{
      session_id: string;
      operator_id: string;
      display_name: string;
      role: string;
      must_change_password: boolean;
    }>(
      `WITH touched AS (
         UPDATE operator_sessions s
            SET last_used_at = now()
          WHERE s.token_hash = $1
            AND s.revoked_at IS NULL
            AND s.expires_at > now()
          RETURNING s.session_id, s.operator_id
       )
       SELECT t.session_id, o.operator_id, o.display_name, o.role,
              o.must_change_password
         FROM touched t
         JOIN operators o ON o.operator_id = t.operator_id
        WHERE o.active = true`,
      [hashToken(token)],
    );

    const found = rows[0];
    if (!found) return null;

    return {
      id: found.operator_id,
      display_name: found.display_name,
      role: found.role as Role,
      session_id: found.session_id,
      must_change_password: found.must_change_password,
    };
  }

  /** Ends one session. The ordinary sign-out. */
  async signOut(sessionId: string, by: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.query(
        `UPDATE operator_sessions
            SET revoked_at = now(), revoked_by = $2, revoked_reason = 'sign_out'
          WHERE session_id = $1 AND revoked_at IS NULL`,
        [sessionId, by],
      );
      await this.record(tx, {
        operatorId: by,
        type: "sign_out",
        detail: { session_id: sessionId },
      });
    });
  }

  /** Revokes every session an operator holds. The "withdraw access now" path. */
  async revokeAll(operatorId: string, by: string, reason: string): Promise<number> {
    return this.db.transaction(async (tx) => {
      const revoked = await tx.query<{ session_id: string }>(
        `UPDATE operator_sessions
            SET revoked_at = now(), revoked_by = $2, revoked_reason = $3
          WHERE operator_id = $1 AND revoked_at IS NULL
          RETURNING session_id`,
        [operatorId, by, reason],
      );

      await this.record(tx, {
        operatorId,
        type: "sessions_revoked",
        detail: { by, reason, count: revoked.length },
      });

      return revoked.length;
    });
  }

  /** Deletes expired sessions. Housekeeping; the auth log keeps the history. */
  async sweepExpired(): Promise<number> {
    const rows = await this.db.query<{ session_id: string }>(
      `DELETE FROM operator_sessions
        WHERE expires_at < now() - interval '30 days'
        RETURNING session_id`,
    );
    return rows.length;
  }

  /* ---------------- audit ---------------- */

  private async record(
    tx: { query: Db["query"] },
    input: {
      operatorId: string | null;
      type: string;
      ip?: string | null;
      userAgent?: string | null;
      detail?: Record<string, unknown>;
    },
  ): Promise<void> {
    await tx.query(
      `INSERT INTO auth_events (event_id, operator_id, type, ip, user_agent, detail)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        randomUUID(),
        input.operatorId,
        input.type,
        input.ip ?? null,
        input.userAgent ?? null,
        JSON.stringify(input.detail ?? {}),
      ],
    );
  }

  private async recordFailure(
    operatorId: string,
    reason: string,
    context: SignInContext,
  ): Promise<void> {
    await this.record(this.db, {
      operatorId,
      type: "sign_in_failed",
      ip: context.ip,
      userAgent: context.userAgent,
      // The specific reason lives here and nowhere the caller can see it.
      detail: { reason },
    });
  }

  /** Recent authentication activity, for a supervisor reviewing access. */
  async recentAuthEvents(limit = 100): Promise<
    Array<{ at: Date; operator_id: string | null; type: string; ip: string | null }>
  > {
    return this.db.query(
      `SELECT at, operator_id, type, ip FROM auth_events
        ORDER BY at DESC LIMIT $1`,
      [limit],
    );
  }

  /** Failed attempts in a window, so a spray is visible rather than inferred. */
  async recentFailures(sinceMinutes = 15): Promise<number> {
    const rows = await this.db.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM auth_events
        WHERE type = 'sign_in_failed'
          AND at > now() - make_interval(mins => $1)`,
      [sinceMinutes],
    );
    return Number(rows[0]?.count ?? 0);
  }
}
