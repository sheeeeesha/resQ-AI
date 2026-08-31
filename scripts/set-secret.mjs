/**
 * Writes a secret into apps/api/.env without it appearing anywhere it shouldn't.
 *
 * Typing a secret as a shell argument puts it in your shell history and in the
 * process list; pasting it into a chat puts it somewhere you cannot revoke it
 * from. This prompts with echo disabled and never prints it back.
 *
 *   node scripts/set-secret.mjs EXTRACTION_API_KEY
 */

import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";

const ENV_PATH = "apps/api/.env";
const name = process.argv[2];

if (!name || !/^[A-Z][A-Z0-9_]*$/.test(name)) {
  console.error("Usage: node scripts/set-secret.mjs VARIABLE_NAME");
  process.exit(1);
}

function promptHidden(question) {
  return new Promise((resolve, reject) => {
    const input = process.stdin;
    if (!input.isTTY) {
      reject(new Error("This needs an interactive terminal."));
      return;
    }
    const rl = createInterface({ input, output: process.stdout, terminal: true });
    const originalWrite = rl._writeToOutput?.bind(rl);
    rl._writeToOutput = (chunk) => {
      if (chunk.includes(question)) originalWrite?.(chunk);
    };
    process.stdout.write(question);
    rl.question("", (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer.trim());
    });
    rl.on("SIGINT", () => { rl.close(); reject(new Error("Cancelled.")); });
  });
}

const env = await readFile(ENV_PATH, "utf8").catch(() => {
  console.error(`${ENV_PATH} not found.`);
  process.exit(1);
});

const value = await promptHidden(`${name} (input hidden): `);
if (!value) {
  console.error("Nothing entered; unchanged.");
  process.exit(1);
}

const lines = env.split("\n");
const idx = lines.findIndex((l) => l.trimStart().startsWith(`${name}=`));
if (idx >= 0) lines[idx] = `${name}=${value}`;
else lines.push(`${name}=${value}`);

await writeFile(ENV_PATH, lines.join("\n"), "utf8");

console.log(`\nWrote ${name} to ${ENV_PATH}`);
console.log(`  ${name}=${value.slice(0, 4)}${"*".repeat(Math.min(value.length - 4, 24))}`);
