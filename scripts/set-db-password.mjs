/**
 * Sets the database password in apps/api/.env without it appearing anywhere it
 * shouldn't.
 *
 * Typing a password as a shell argument puts it in your shell history and in
 * the process list; pasting it into a chat puts it somewhere you cannot revoke
 * it from. This prompts with echo disabled, writes it to .env (which is
 * gitignored), and never prints it back.
 *
 * It also percent-encodes the password before putting it in the URL. Supabase
 * generates passwords containing characters like @ : / ? # & — every one of
 * which is structural in a connection URI. An unencoded `@` silently truncates
 * the host and produces a confusing "getaddrinfo ENOTFOUND" rather than an auth
 * error, which is a genuinely annoying half-hour to debug.
 *
 *   npm run db:password
 */

import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const ENV_PATH = "apps/api/.env";

/** Reads a line from the terminal without echoing it. */
function promptHidden(question) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;

    if (!input.isTTY) {
      reject(
        new Error(
          "This needs an interactive terminal. Run it directly rather than " +
            "through a pipe or a task runner.",
        ),
      );
      return;
    }

    const rl = createInterface({ input, output: process.stdout, terminal: true });

    // Suppress echo: readline still receives keystrokes, the terminal just
    // does not render them.
    const originalWrite = rl._writeToOutput?.bind(rl);
    rl._writeToOutput = (chunk) => {
      if (chunk.includes(question)) originalWrite?.(chunk);
    };

    process.stdout.write(question);
    rl.question("", (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
    rl.on("SIGINT", () => {
      rl.close();
      process.stdout.write("\n");
      reject(new Error("Cancelled."));
    });
  });
}

function replacePassword(url, password) {
  // postgresql://user:password@host:port/db
  const match = /^(\w+:\/\/)([^:/@]+):([^@]*)@(.+)$/.exec(url);
  if (!match) {
    throw new Error(
      `DATABASE_URL in ${ENV_PATH} is not in the expected ` +
        `postgresql://user:password@host/db form. Fix it and re-run.`,
    );
  }
  const [, scheme, user, , rest] = match;
  return `${scheme}${user}:${encodeURIComponent(password)}@${rest}`;
}

async function main() {
  let env;
  try {
    env = await readFile(ENV_PATH, "utf8");
  } catch {
    throw new Error(
      `${ENV_PATH} not found. Copy apps/api/.env.example to apps/api/.env first.`,
    );
  }

  const line = env
    .split("\n")
    .find((l) => l.trimStart().startsWith("DATABASE_URL="));
  if (!line) throw new Error(`No DATABASE_URL line found in ${ENV_PATH}.`);

  const currentUrl = line.slice(line.indexOf("=") + 1).trim();

  const password = await promptHidden("Database password (input hidden): ");
  if (!password) throw new Error("No password entered; nothing changed.");

  const updated = replacePassword(currentUrl, password);
  await writeFile(
    ENV_PATH,
    env.replace(line, `DATABASE_URL=${updated}`),
    "utf8",
  );

  // Report the shape, never the value.
  const host = updated.split("@")[1] ?? "unknown";
  console.log(`\nWrote DATABASE_URL to ${ENV_PATH}`);
  console.log(`  host     ${host}`);
  console.log(`  password ${"*".repeat(Math.min(password.length, 24))} (percent-encoded)`);

  if (host.includes(":6543")) {
    console.warn(
      "\nWARNING: port 6543 is the transaction pooler. It does not preserve " +
        "session state, which silently breaks the SELECT ... FOR UPDATE that " +
        "optimistic concurrency relies on. Use the session pooler on 5432.",
    );
  }

  console.log("\nNext:  npm run db:check");
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  process.exitCode = 1;
});
