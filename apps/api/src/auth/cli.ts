import { createInterface } from "node:readline";
import { loadConfig } from "../config.js";
import { connect } from "../db/connect.js";
import { OperatorService, ROLES, type Role } from "./operators.js";

/**
 * Operator administration.
 *
 *   npm run operators                          list
 *   npm run operators -- --add <id> --role r   create, prompting for a password
 *   npm run operators -- --disable <id> --reason "..."
 *   npm run operators -- --revoke <id> --reason "..."
 *   npm run operators -- --password <id>       set a new password
 *   npm run operators -- --auth-log
 *
 * Passwords are prompted for with echo disabled and never accepted as an
 * argument. A password on a command line is in the shell history and the
 * process list, which is a worse exposure than the one the hashing prevents.
 */

function promptHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error("A password prompt needs an interactive terminal."));
      return;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const write = (rl as unknown as { _writeToOutput?: (s: string) => void })._writeToOutput?.bind(rl);
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (chunk: string) => {
      if (chunk.includes(question)) write?.(chunk);
    };
    process.stdout.write(question);
    rl.question("", (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

function flag(argv: string[], name: string): string | null {
  const index = argv.indexOf(name);
  return index >= 0 ? (argv[index + 1] ?? null) : null;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const config = loadConfig();
  const db = connect(config.DATABASE_URL);
  const operators = new OperatorService(db);

  try {
    const add = flag(argv, "--add");
    const disable = flag(argv, "--disable");
    const revoke = flag(argv, "--revoke");
    const password = flag(argv, "--password");
    const by = flag(argv, "--by") ?? "cli";

    if (add) {
      const role = (flag(argv, "--role") ?? "call_taker") as Role;
      if (!ROLES.includes(role)) {
        console.error(`Unknown role "${role}". One of: ${ROLES.join(", ")}`);
        process.exitCode = 1;
        return;
      }

      const secret = await promptHidden(`Password for ${add} (hidden): `);
      if (secret.length < 12) {
        // Short enough to guess offline given the hash. Refused here rather
        // than left to whoever is creating the account to judge.
        console.error("Too short. Use at least 12 characters.");
        process.exitCode = 1;
        return;
      }

      await operators.create({
        operatorId: add,
        displayName: flag(argv, "--name") ?? add,
        role,
        password: secret,
        mustChangePassword: true,
      });

      console.log(`Created ${add} as ${role}. They must change it on first sign-in.`);
      return;
    }

    if (password) {
      const secret = await promptHidden(`New password for ${password} (hidden): `);
      if (secret.length < 12) {
        console.error("Too short. Use at least 12 characters.");
        process.exitCode = 1;
        return;
      }
      await operators.setPassword(password, secret);
      const revoked = await operators.revokeAll(password, by, "password_changed");
      // Changing a password without ending existing sessions leaves whoever
      // knew the old one signed in, which defeats the reason for changing it.
      console.log(`Password set for ${password}; ${revoked} session(s) ended.`);
      return;
    }

    if (disable) {
      const reason = flag(argv, "--reason") ?? "no reason given";
      const revoked = await operators.disable(disable, reason, by);
      console.log(`Disabled ${disable}; ${revoked} session(s) ended.`);
      console.log("The account row is kept so past overrides stay attributable.");
      return;
    }

    if (revoke) {
      const reason = flag(argv, "--reason") ?? "no reason given";
      const count = await operators.revokeAll(revoke, by, reason);
      console.log(`Ended ${count} session(s) for ${revoke}. The account stays active.`);
      return;
    }

    if (argv.includes("--auth-log")) {
      const events = await operators.recentAuthEvents(40);
      console.log("Recent authentication activity\n");
      for (const event of events) {
        console.log(
          `  ${new Date(event.at).toISOString()}  ${(event.operator_id ?? "-").padEnd(20)}` +
            `${event.type.padEnd(18)}${event.ip ?? ""}`,
        );
      }
      const failures = await operators.recentFailures(15);
      if (failures > 0) {
        console.log(`\n  ${failures} failed attempt(s) in the last 15 minutes.`);
      }
      return;
    }

    const list = await operators.list();
    console.log("Operators\n");
    if (list.length === 0) {
      console.log("  none yet — create one with --add <id> --role <role>");
      console.log(`  roles: ${ROLES.join(", ")}`);
    }
    for (const operator of list) {
      console.log(
        `  ${operator.operator_id.padEnd(20)}${operator.role.padEnd(12)}` +
          `${operator.active ? "active" : "DISABLED"}`.padEnd(10) +
          `${operator.last_seen_at ? "last seen " + new Date(operator.last_seen_at).toISOString().slice(0, 16) : "never signed in"}`,
      );
    }

    if (config.OPERATOR_TOKENS) {
      console.log(
        "\n  OPERATOR_TOKENS is still set. It is the fallback while accounts are",
      );
      console.log("  created; those tokens cannot be revoked, so remove it once every");
      console.log("  operator has an account.");
    }
  } finally {
    await db.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
