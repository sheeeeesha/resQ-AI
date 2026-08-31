import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.js";

const MINIMAL = {
  DATABASE_URL: "postgresql://u:p@host:5432/db",
};

test("an empty optional variable is treated as unset, not as a bad value", () => {
  // A .env containing `CALLER_NUMBER_SALT=` yields "" rather than undefined.
  // Before this was normalised, the placeholder line every .env template ships
  // with failed validation and blamed the length rule.
  const config = loadConfig({ ...MINIMAL, CALLER_NUMBER_SALT: "" } as NodeJS.ProcessEnv);
  assert.equal(config.CALLER_NUMBER_SALT, undefined);
});

test("an empty variable falls back to its default", () => {
  const config = loadConfig({ ...MINIMAL, PORT: "", LOG_LEVEL: "" } as NodeJS.ProcessEnv);
  assert.equal(config.PORT, 5000);
  assert.equal(config.LOG_LEVEL, "info");
});

test("a short salt is still rejected when actually provided", () => {
  assert.throws(
    () => loadConfig({ ...MINIMAL, CALLER_NUMBER_SALT: "tooshort" } as NodeJS.ProcessEnv),
    /CALLER_NUMBER_SALT/,
  );
});

test("a missing DATABASE_URL is reported by name", () => {
  assert.throws(() => loadConfig({} as NodeJS.ProcessEnv), /DATABASE_URL/);
});

test("production names every missing requirement at once", () => {
  // Reporting one at a time turns configuring a deployment into a guessing
  // game of fix-one-thing-and-rerun.
  assert.throws(
    () => loadConfig({ ...MINIMAL, NODE_ENV: "production" } as NodeJS.ProcessEnv),
    (err: Error) =>
      /CALLER_NUMBER_SALT/.test(err.message) && /OPERATOR_TOKENS/.test(err.message),
  );
});

test("production requires operator tokens, or nothing can be confirmed", () => {
  assert.throws(
    () =>
      loadConfig({
        ...MINIMAL,
        NODE_ENV: "production",
        CALLER_NUMBER_SALT: "a".repeat(32),
      } as NodeJS.ProcessEnv),
    /OPERATOR_TOKENS/,
  );
});

test("production is satisfied once both are present", () => {
  const config = loadConfig({
    ...MINIMAL,
    NODE_ENV: "production",
    CALLER_NUMBER_SALT: "a".repeat(32),
    OPERATOR_TOKENS: "tok:op-1",
  } as NodeJS.ProcessEnv);
  assert.equal(config.NODE_ENV, "production");
});

test("development does not demand production secrets", () => {
  // A developer running the pipeline locally should not have to invent an
  // operator token to see it work.
  const config = loadConfig(MINIMAL as NodeJS.ProcessEnv);
  assert.equal(config.NODE_ENV, "development");
  assert.equal(config.CALLER_NUMBER_SALT, undefined);
});

test("PORT is coerced and range-checked", () => {
  assert.equal(loadConfig({ ...MINIMAL, PORT: "8080" } as NodeJS.ProcessEnv).PORT, 8080);
  assert.throws(
    () => loadConfig({ ...MINIMAL, PORT: "99999" } as NodeJS.ProcessEnv),
    /PORT/,
  );
});
