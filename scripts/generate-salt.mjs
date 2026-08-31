/**
 * Generates CALLER_NUMBER_SALT and writes it into apps/api/.env.
 *
 * The salt is what stops a stored phone-number hash from being a rainbow-table
 * lookup away from the number itself. Indian mobile numbers are a 10-digit
 * space with a known prefix structure — small enough to enumerate exhaustively,
 * so an unsalted hash offers effectively no protection at all.
 *
 *   node scripts/generate-salt.mjs            # dev, writes to apps/api/.env
 *   node scripts/generate-salt.mjs --print    # print only, for a secret manager
 *
 * Changing the salt invalidates every existing hash: the same caller will no
 * longer match their prior incidents. Rotate deliberately, not casually.
 */

import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const ENV_PATH = "apps/api/.env";
const salt = randomBytes(32).toString("hex");

if (process.argv.includes("--print")) {
  process.stdout.write(`${salt}\n`);
  process.exit(0);
}

const env = await readFile(ENV_PATH, "utf8").catch(() => {
  console.error(`${ENV_PATH} not found.`);
  process.exit(1);
});

const lines = env.split("\n");
const idx = lines.findIndex((l) => l.trimStart().startsWith("CALLER_NUMBER_SALT="));

const existing = idx >= 0 ? lines[idx].split("=")[1]?.trim() : "";
if (existing) {
  console.error(
    "CALLER_NUMBER_SALT is already set. Rotating it invalidates every " +
      "existing caller hash.\nClear the line by hand first if that is what you intend.",
  );
  process.exit(1);
}

if (idx >= 0) lines[idx] = `CALLER_NUMBER_SALT=${salt}`;
else lines.push(`CALLER_NUMBER_SALT=${salt}`);

await writeFile(ENV_PATH, lines.join("\n"), "utf8");

console.log(`Wrote a 256-bit salt to ${ENV_PATH}`);
console.log(`  CALLER_NUMBER_SALT=${salt.slice(0, 8)}${"*".repeat(24)}`);
console.log("\nThis is a development salt. Production should use a distinct");
console.log("value held in a secret manager, never one from a .env file.");
