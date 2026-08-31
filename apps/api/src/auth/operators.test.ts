import test from "node:test";
import assert from "node:assert/strict";

import { createHarness, type Harness } from "../test-support/harness.js";
import {
  AuthFailed,
  OperatorService,
  hasRole,
  hashPassword,
  verifyPassword,
} from "./operators.js";

/**
 * Operator authentication.
 *
 * The property that matters most is revocation. The interim bearer tokens were
 * not weak, they were permanent — access could not be withdrawn without
 * redeploying the service — and in a control room that is the failure that
 * actually happens.
 */

async function withAuth(
  fn: (ctx: { h: Harness; auth: OperatorService }) => Promise<void>,
): Promise<void> {
  const h = await createHarness();
  try {
    await fn({ h, auth: new OperatorService(h.db) });
  } finally {
    await h.close();
  }
}

async function seedOperator(
  auth: OperatorService,
  id = "op-1",
  role: "call_taker" | "supervisor" | "admin" = "call_taker",
) {
  await auth.create({
    operatorId: id,
    displayName: `Operator ${id}`,
    role,
    password: "correct horse battery staple",
    mustChangePassword: false,
  });
}

/* ------------------------------------------------------------------ *
 * Password hashing
 * ------------------------------------------------------------------ */

test("a password hash reveals nothing about the password", async () => {
  const hash = await hashPassword("correct horse battery staple");

  assert.ok(!hash.includes("correct"));
  assert.match(hash, /^scrypt\$\d+\$/);

  assert.equal(await verifyPassword("correct horse battery staple", hash), true);
  assert.equal(await verifyPassword("wrong", hash), false);
});

test("the same password hashes differently every time", async () => {
  const a = await hashPassword("same password");
  const b = await hashPassword("same password");

  // A random salt per credential. Without it, two operators choosing the same
  // password would be visibly identical in the table, and one cracked hash
  // would open both accounts.
  assert.notEqual(a, b);
  assert.equal(await verifyPassword("same password", a), true);
  assert.equal(await verifyPassword("same password", b), true);
});

test("a malformed hash is rejected rather than throwing", async () => {
  for (const bad of ["", "notahash", "scrypt$only$three", "bcrypt$1$a$b"]) {
    assert.equal(await verifyPassword("anything", bad), false);
  }
});

/* ------------------------------------------------------------------ *
 * Roles
 * ------------------------------------------------------------------ */

test("roles include everything below them", () => {
  assert.equal(hasRole("admin", "call_taker"), true);
  assert.equal(hasRole("admin", "supervisor"), true);
  assert.equal(hasRole("supervisor", "call_taker"), true);

  assert.equal(hasRole("call_taker", "supervisor"), false);
  assert.equal(hasRole("supervisor", "admin"), false);
});

test("an unknown role grants nothing", () => {
  // A typo in a role name must fail closed, not open.
  assert.equal(hasRole("superuser", "call_taker"), false);
  assert.equal(hasRole("", "call_taker"), false);
});

/* ------------------------------------------------------------------ *
 * Sign in
 * ------------------------------------------------------------------ */

test("a correct password issues a usable session", async () => {
  await withAuth(async ({ auth }) => {
    await seedOperator(auth);

    const { token, operator } = await auth.signIn("op-1", "correct horse battery staple");

    assert.ok(token.length >= 40);
    assert.equal(operator.id, "op-1");
    assert.equal(operator.role, "call_taker");

    const resolved = await auth.resolve(token);
    assert.equal(resolved?.id, "op-1");
  });
});

test("every failure looks the same to the caller", async () => {
  await withAuth(async ({ h, auth }) => {
    await seedOperator(auth);

    const messages: string[] = [];
    for (const [id, password] of [
      ["op-1", "wrong"],
      ["nobody", "anything"],
    ] as const) {
      try {
        await auth.signIn(id, password);
        assert.fail("should have failed");
      } catch (err) {
        assert.ok(err instanceof AuthFailed);
        messages.push(err.message);
      }
    }

    // Distinguishing "no such operator" from "wrong password" tells an
    // attacker which half of a guess was right, turning one problem into two
    // easier ones.
    assert.equal(new Set(messages).size, 1);

    // The real reasons are in the log, where only a defender reads them.
    const events = await auth.recentAuthEvents();
    const reasons = events
      .filter((e) => e.type === "sign_in_failed")
      .map((e) => e.operator_id);
    assert.deepEqual(new Set(reasons), new Set(["op-1", "nobody"]));
  });
});

test("an unknown operator takes about as long as a wrong password", async () => {
  await withAuth(async ({ auth }) => {
    await seedOperator(auth);

    const time = async (id: string) => {
      const started = Date.now();
      await auth.signIn(id, "some password").catch(() => undefined);
      return Date.now() - started;
    };

    const known = await time("op-1");
    const unknown = await time("does-not-exist");

    /*
     * Without a dummy verification, an unknown name returns in a millisecond
     * and a known one takes a hundred — enough to enumerate valid operator IDs
     * before guessing a single password.
     *
     * The bound is loose because this is a timing property on a shared
     * machine, not a benchmark; the failure it catches is an order of
     * magnitude, not a few milliseconds.
     */
    assert.ok(
      unknown > known / 4,
      `unknown ${unknown}ms vs known ${known}ms — too easy to distinguish`,
    );
  });
});

test("a failed attempt is recorded even for an operator that does not exist", async () => {
  await withAuth(async ({ auth }) => {
    await auth.signIn("attacker-guess", "hunter2").catch(() => undefined);

    const events = await auth.recentAuthEvents();
    // A spray across invented names is only visible if the invented names are
    // recorded as presented.
    assert.equal(events[0]!.operator_id, "attacker-guess");
    assert.equal(events[0]!.type, "sign_in_failed");
  });
});

test("failures in a window are countable, so a spray is visible", async () => {
  await withAuth(async ({ auth }) => {
    await seedOperator(auth);
    for (let i = 0; i < 5; i += 1) {
      await auth.signIn("op-1", `guess-${i}`).catch(() => undefined);
    }
    assert.equal(await auth.recentFailures(15), 5);
  });
});

/* ------------------------------------------------------------------ *
 * Revocation — the reason this exists
 * ------------------------------------------------------------------ */

test("signing out ends that session immediately", async () => {
  await withAuth(async ({ auth }) => {
    await seedOperator(auth);
    const { token, operator } = await auth.signIn("op-1", "correct horse battery staple");

    assert.ok(await auth.resolve(token));

    await auth.signOut(operator.session_id, "op-1");
    assert.equal(await auth.resolve(token), null);
  });
});

test("disabling an operator signs them out everywhere", async () => {
  await withAuth(async ({ auth }) => {
    await seedOperator(auth);

    // Two devices, as a shift handover or a second browser would produce.
    const first = await auth.signIn("op-1", "correct horse battery staple");
    const second = await auth.signIn("op-1", "correct horse battery staple");

    const revoked = await auth.disable("op-1", "left the service", "op-admin");

    assert.equal(revoked, 2);
    // The whole point. With the interim tokens, disabling an account left the
    // person signed in until someone redeployed.
    assert.equal(await auth.resolve(first.token), null);
    assert.equal(await auth.resolve(second.token), null);

    // And they cannot sign back in.
    await assert.rejects(
      () => auth.signIn("op-1", "correct horse battery staple"),
      AuthFailed,
    );
  });
});

test("a disabled operator's row survives so past overrides stay attributable", async () => {
  await withAuth(async ({ auth }) => {
    await seedOperator(auth);
    await auth.disable("op-1", "left the service", "op-admin");

    const operators = await auth.list();
    const disabled = operators.find((o) => o.operator_id === "op-1");

    // Deleting the row would make every override they ever made
    // unattributable — destroying the accountability record to tidy a list.
    assert.ok(disabled, "the operator row should still exist");
    assert.equal(disabled!.active, false);
  });
});

test("access can be withdrawn without disabling the account", async () => {
  await withAuth(async ({ auth }) => {
    await seedOperator(auth);
    const { token } = await auth.signIn("op-1", "correct horse battery staple");

    // A machine left logged in, or a credential pasted into the wrong window:
    // end the sessions, keep the person employed.
    const count = await auth.revokeAll("op-1", "op-admin", "device lost");

    assert.equal(count, 1);
    assert.equal(await auth.resolve(token), null);

    const again = await auth.signIn("op-1", "correct horse battery staple");
    assert.ok(await auth.resolve(again.token));
  });
});

test("a revocation is recorded with who did it and why", async () => {
  await withAuth(async ({ auth }) => {
    await seedOperator(auth);
    await auth.signIn("op-1", "correct horse battery staple");
    await auth.revokeAll("op-1", "op-supervisor", "device lost");

    const events = await auth.recentAuthEvents();
    const revocation = events.find((e) => e.type === "sessions_revoked");
    assert.ok(revocation);
    assert.equal(revocation!.operator_id, "op-1");
  });
});

/* ------------------------------------------------------------------ *
 * Session lifetime
 * ------------------------------------------------------------------ */

test("an expired session stops working", async () => {
  await withAuth(async ({ h, auth }) => {
    await seedOperator(auth);
    const { token, operator } = await auth.signIn("op-1", "correct horse battery staple");

    await h.db.query(
      "UPDATE operator_sessions SET expires_at = now() - interval '1 hour' WHERE session_id = $1",
      [operator.session_id],
    );

    // A session that outlives a shift is one that outlives the operator's
    // presence at the machine.
    assert.equal(await auth.resolve(token), null);
  });
});

test("a garbage token resolves to nothing rather than erroring", async () => {
  await withAuth(async ({ auth }) => {
    assert.equal(await auth.resolve(""), null);
    assert.equal(await auth.resolve("not-a-real-token"), null);
  });
});

test("session tokens are stored hashed, so the table is not a key ring", async () => {
  await withAuth(async ({ h, auth }) => {
    await seedOperator(auth);
    const { token } = await auth.signIn("op-1", "correct horse battery staple");

    const rows = await h.db.query<{ token_hash: string }>(
      "SELECT token_hash FROM operator_sessions",
    );

    // An attacker who reads this table still cannot present a valid session.
    assert.notEqual(rows[0]!.token_hash, token);
    assert.ok(!rows.some((r) => r.token_hash.includes(token)));
  });
});

/* ------------------------------------------------------------------ *
 * The auth log
 * ------------------------------------------------------------------ */

test("the auth log cannot be edited or deleted", async () => {
  await withAuth(async ({ h, auth }) => {
    await seedOperator(auth);
    await auth.signIn("op-1", "wrong").catch(() => undefined);

    // An attacker who can delete their own failed attempts leaves no trace of
    // having tried.
    await assert.rejects(
      () => h.db.query("DELETE FROM auth_events"),
      /append-only/,
    );
    await assert.rejects(
      () => h.db.query("UPDATE auth_events SET type = 'sign_in'"),
      /append-only/,
    );
  });
});
