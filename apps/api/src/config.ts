import { z } from "zod";

/**
 * Environment configuration, validated once at startup.
 *
 * Fails fast and loudly on a missing or malformed variable rather than
 * surfacing it later as an undefined deep inside a request. The prototype read
 * `process.env.FIREBASE_ADMIN_CREDENTIALS` and passed it straight to
 * `JSON.parse` at module load, so a missing variable crashed the process with
 * a parse error that named neither the variable nor the cause.
 *
 * Nothing here has a default that would work in production by accident. If a
 * value matters, it is required.
 */

const EnvSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),

  /** Postgres connection string. */
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  PORT: z.coerce.number().int().min(1).max(65535).default(5000),

  /**
   * Salt for hashing caller numbers. Required in production: without it the
   * hash is a rainbow-table lookup away from the raw number, which defeats the
   * point of storing a hash at all.
   */
  CALLER_NUMBER_SALT: z.string().min(16).optional(),

  /** Default retention window in days, per the operating agency's policy. */
  RETENTION_DAYS: z.coerce.number().int().positive().default(90),

  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  /* ---- channel credentials ---- */

  /** Meta app secret. Signs the X-Hub-Signature-256 header. */
  WHATSAPP_APP_SECRET: z.string().min(1).optional(),
  /** Echoed during Meta's webhook registration handshake. */
  WHATSAPP_VERIFY_TOKEN: z.string().min(1).optional(),

  /** Twilio auth token, used to verify X-Twilio-Signature. */
  TWILIO_AUTH_TOKEN: z.string().min(1).optional(),

  /**
   * The public URL this service is reached at, e.g. https://api.example.in
   *
   * Configured rather than reconstructed from the request: behind a proxy that
   * terminates TLS, the URL Node observes is `http://` while Twilio signed
   * `https://`, so a reconstructed URL fails verification in exactly the
   * deployment where it matters.
   */
  PUBLIC_URL: z.string().url().optional(),

  /* ---- operators ---- */

  /**
   * Interim operator tokens as `token:operatorId` pairs, comma separated.
   * Replaced by real authentication in M7. What cannot wait is the identity —
   * an override trail that cannot say who overrode is worthless.
   */
  OPERATOR_TOKENS: z.string().optional(),

  /* ---- extraction ---- */

  /** Omit to run on the rule-based fallback, which needs no credentials. */
  ANTHROPIC_API_KEY: z.string().min(1).optional(),

  /**
   * Override the model API host.
   *
   * Any gateway implementing Anthropic's Messages API works — OpenCode Zen is
   * `https://opencode.ai/zen/v1`. Note that a gateway is an additional data
   * processor in the chain: emergency transcripts contain personal data under
   * the DPDP Act, so who operates it and where it runs is a real question for
   * production, even where it is the pragmatic choice for an MVP.
   */
  ANTHROPIC_BASE_URL: z.string().url().optional(),

  /**
   * Which provider to run extraction on.
   *
   * `auto` picks by what is configured: an OpenAI-compatible base URL wins,
   * then an Anthropic key, then the rule-based fallback. Set explicitly to
   * pin it.
   */
  EXTRACTION_PROVIDER: z
    .enum(["auto", "claude", "openai-compatible", "rule-based"])
    .default("auto"),

  /**
   * API key for an OpenAI-compatible endpoint — OpenCode Go/Zen, DeepSeek,
   * OpenRouter, a local vLLM.
   */
  EXTRACTION_API_KEY: z.string().min(1).optional(),

  /** Base URL of that endpoint, without the trailing /chat/completions. */
  EXTRACTION_BASE_URL: z.string().url().optional(),

  EXTRACTION_MODEL: z.string().default("claude-opus-5"),
  EXTRACTION_EFFORT: z.enum(["low", "medium", "high"]).default("medium"),

  /**
   * Force JSON mode instead of forced tool calling on OpenAI-compatible
   * endpoints. Measurably weaker — see openai-compatible.ts — so only for
   * endpoints that accept tools but handle them badly.
   */
  EXTRACTION_PREFER_JSON_MODE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  /**
   * Origins allowed to call this API from a browser, comma separated.
   *
   * An allowlist, never a wildcard. `Access-Control-Allow-Origin: *` cannot be
   * combined with credentials, and more to the point it would let any page on
   * the internet make authenticated calls with an operator's token if that
   * token ever leaked into a hostile page's reach.
   *
   * Defaults to the local console so development needs no configuration.
   */
  CONSOLE_ORIGINS: z.string().default("http://localhost:3000"),

  /**
   * How long an operator session lasts, in hours.
   *
   * Defaults to a shift. A session that outlives the shift outlives the
   * operator being at the machine, which is the situation the whole session
   * mechanism exists to bound.
   */
  SESSION_HOURS: z.coerce.number().int().min(1).max(168).default(12),

  /* ---- location and dispatch ---- */

  /**
   * OSRM base URL for road routing. Omit to fall back to straight-line
   * estimates, which are flagged on every unit they produce.
   *
   * The public demo server is fine for development and explicitly not for
   * production; a self-hosted instance with an India extract is the answer
   * there, and needs no code change beyond this value.
   */
  OSRM_BASE_URL: z.string().url().optional(),

  /**
   * Contact identifier for Nominatim, required by its usage policy. Omit to
   * disable landmark geocoding — exact locations still resolve offline.
   */
  NOMINATIM_USER_AGENT: z.string().min(5).optional(),

  /** Two-letter prefix for operator-facing incident references. */
  REFERENCE_PREFIX: z.string().length(2).default("IN"),
});

export type Config = z.infer<typeof EnvSchema>;

/**
 * Treats an empty environment variable as absent.
 *
 * A `.env` file that declares `CALLER_NUMBER_SALT=` yields `""`, not
 * `undefined` — so an optional field with a minimum length fails validation
 * instead of falling back to its default, and the error blames the value
 * rather than the blank line that caused it. Every commented-out or
 * placeholder variable in a `.env` hits this, so it is normalised once here
 * rather than per-field.
 */
function stripEmpty(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [
      key,
      value === "" ? undefined : value,
    ]),
  );
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(stripEmpty(env));

  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `  ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${detail}`);
  }

  const config = parsed.data;

  if (config.NODE_ENV === "production") {
    const missing: string[] = [];

    if (!config.CALLER_NUMBER_SALT) {
      missing.push(
        "CALLER_NUMBER_SALT — an unsalted phone-number hash offers no real protection",
      );
    }
    if (!config.OPERATOR_TOKENS) {
      missing.push(
        "OPERATOR_TOKENS — without it no operator can confirm or override anything",
      );
    }

    if (missing.length > 0) {
      throw new Error(
        `Missing required production configuration:\n${missing.map((m) => `  ${m}`).join("\n")}`,
      );
    }
  }

  return config;
}

/**
 * Whether a channel's webhook can be accepted.
 *
 * A channel whose signing secret is absent is not merely degraded — it is an
 * open endpoint that would accept fabricated emergencies from anyone who found
 * the URL. Unconfigured channels are refused outright rather than served
 * unverified, and this reports which are usable so the refusal is deliberate.
 */
export function channelReadiness(config: Config): {
  whatsapp: boolean;
  sms: boolean;
} {
  return {
    whatsapp: Boolean(config.WHATSAPP_APP_SECRET),
    sms: Boolean(config.TWILIO_AUTH_TOKEN && config.PUBLIC_URL),
  };
}
