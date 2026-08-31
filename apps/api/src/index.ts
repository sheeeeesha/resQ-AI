import { loadConfig, channelReadiness, type Config } from "./config.js";
import { connect } from "./db/connect.js";
import { hasSpatialSupport } from "./db/migrate.js";
import { IncidentRepository } from "./repository/incidents.js";
import { ExtractionService } from "./extraction/service.js";
import { ClaudeExtractionProvider } from "./extraction/claude.js";
import { OpenAICompatibleProvider } from "./extraction/openai-compatible.js";
import { RuleBasedExtractionProvider } from "./extraction/rule-based.js";
import { FallbackExtractionProvider } from "./extraction/fallback.js";
import type { ExtractionProvider } from "./extraction/provider.js";
import { IntakePipeline } from "./pipeline/intake.js";
import { buildServer } from "./http/server.js";
import { UnitRepository } from "./units/repository.js";
import { DispatchService } from "./units/dispatch.js";
import { OsrmRouter, StraightLineRouter } from "./units/routing.js";
import { LocationResolver } from "./location/resolve.js";
import { NominatimGeocoder, NullGeocoder } from "./location/geocode.js";
import { IncidentNotifier } from "./realtime/notifier.js";
import { OperatorService } from "./auth/operators.js";

/**
 * Service entry point.
 *
 * Starts only after establishing what it can actually do, and says so. A
 * service that boots cleanly while silently missing its signing secrets, its
 * model credentials or its spatial extension looks healthy right up until the
 * first request that needed one.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const db = connect(config.DATABASE_URL);
  const repo = new IncidentRepository(db);

  // Fail before binding a port rather than after. A service accepting webhooks
  // it cannot store is worse than one that never started.
  try {
    await db.query("SELECT 1");
  } catch (err) {
    console.error(
      `Cannot reach the database: ${err instanceof Error ? err.message : err}`,
    );
    process.exitCode = 1;
    await db.close();
    return;
  }

  const provider = selectProvider(config);

  const units = new UnitRepository(db);

  // A routing engine is optional. Without one, travel times are straight-line
  // estimates and every unit carries the flag saying so.
  const router = config.OSRM_BASE_URL
    ? new OsrmRouter({ baseUrl: config.OSRM_BASE_URL })
    : new StraightLineRouter();

  // A geocoder is optional too. Without one only exact locations resolve —
  // coordinates, Plus Codes and map links, none of which need a network.
  const geocoder = config.NOMINATIM_USER_AGENT
    ? new NominatimGeocoder({
        userAgent: config.NOMINATIM_USER_AGENT,
        countryCode: "in",
      })
    : new NullGeocoder();

  const dispatch = new DispatchService(units, router);

  const pipeline = new IntakePipeline({
    repo,
    location: new LocationResolver(geocoder),
    extraction: new ExtractionService({ provider, medicalPass: true }),
    callerSalt: config.CALLER_NUMBER_SALT ?? "development-only-unsalted",
    referencePrefix: config.REFERENCE_PREFIX,
  });

  // A dedicated connection, not one from the pool: a pooled client holding a
  // LISTEN registration never returns, and a pool that loses members to
  // listeners fails looking like a capacity problem rather than a leak.
  const notifier = new IncidentNotifier(config.DATABASE_URL);
  await notifier.start();

  const accounts = new OperatorService(db, config.SESSION_HOURS);

  const app = buildServer({
    config, db, repo, pipeline, units, dispatch, notifier,
    operators: accounts,
  });

  notifier.on("warning", (message: string) => app.log.warn({ notifier: message }));

  const channels = channelReadiness(config);
  const spatial = await hasSpatialSupport(db);
  const unitCount = await units.count();

  app.log.info(
    {
      extraction: provider.modelId,
      channels,
      spatial,
      routing: router.name,
      geocoder: geocoder.name,
      units: unitCount,
      live_updates: notifier.connected,
      operators: Boolean(config.OPERATOR_TOKENS),
    },
    "starting",
  );

  // Warn loudly about every capability that is absent. Each of these is a
  // silent failure waiting for the request that needs it.
  if (provider.modelId === "rule-based-v1") {
    app.log.warn(
      "No model provider configured: running on keyword matching. Every incident " +
        "will be low-confidence and escalated to a human. Set EXTRACTION_BASE_URL " +
        "and EXTRACTION_API_KEY, or ANTHROPIC_API_KEY.",
    );
  }
  if (!channels.whatsapp) {
    app.log.warn("WhatsApp intake disabled: WHATSAPP_APP_SECRET is not set.");
  }
  if (!channels.sms) {
    app.log.warn("SMS intake disabled: TWILIO_AUTH_TOKEN and PUBLIC_URL are required.");
  }
  if (!config.OPERATOR_TOKENS) {
    app.log.warn("No OPERATOR_TOKENS: nothing can be confirmed or overridden.");
  }
  if (!spatial) {
    app.log.warn(
      "PostGIS absent: proximity search falls back to a bounding-box scan. " +
        "Correct, but it will not hold up at fleet scale.",
    );
  }
  if (geocoder.name === "null") {
    app.log.warn(
      "No geocoder: stated landmarks will not resolve. Coordinates, Plus " +
        "Codes and map links still work, since those need no network.",
    );
  }
  if (router.name === "straight-line") {
    app.log.warn(
      "No routing engine: travel times are straight-line estimates, flagged " +
        "as such on every recommendation.",
    );
  }
  if (unitCount === 0) {
    app.log.warn("No response units registered: nothing can be recommended.");
  }
  if (!config.CALLER_NUMBER_SALT) {
    app.log.warn(
      "No CALLER_NUMBER_SALT: caller hashes are not meaningfully protected. " +
        "Development only.",
    );
  }

  await app.listen({ port: config.PORT, host: "0.0.0.0" });

  // Drain in-flight requests before exiting, so a deploy does not drop a
  // webhook that was mid-flight.
  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutting down");
    try {
      await app.close();
      // Stop listening before closing the pool, so the reconnect loop cannot
      // race the shutdown and re-open a connection on the way out.
      await notifier.stop();
      await db.close();
    } finally {
      process.exit(0);
    }
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

/**
 * Picks the extraction provider.
 *
 * Order under `auto`: an OpenAI-compatible endpoint if one is configured, then
 * an Anthropic key, then keyword matching.
 *
 * The last of those is a fallback, not a failure. It is genuinely weak — it
 * matches words and cannot read negation — but it always escalates and marks
 * its incidents degraded, so a call-taker is never shown its output as though
 * a model had assessed it. Refusing to boot would take the intake path down
 * with it, and a stored transcript with no classification is far better than a
 * lost message.
 */
function selectProvider(config: Config): ExtractionProvider {
  const wantsOpenAI =
    config.EXTRACTION_PROVIDER === "openai-compatible" ||
    (config.EXTRACTION_PROVIDER === "auto" &&
      Boolean(config.EXTRACTION_BASE_URL && config.EXTRACTION_API_KEY));

  if (wantsOpenAI) {
    if (!config.EXTRACTION_BASE_URL || !config.EXTRACTION_API_KEY) {
      throw new Error(
        "EXTRACTION_PROVIDER=openai-compatible requires both " +
          "EXTRACTION_BASE_URL and EXTRACTION_API_KEY.",
      );
    }
    // Wrapped so a rate limit or an outage degrades to keyword matching
    // rather than to nothing. Only retryable failures fall through.
    return new FallbackExtractionProvider(
      new OpenAICompatibleProvider({
        apiKey: config.EXTRACTION_API_KEY,
        baseUrl: config.EXTRACTION_BASE_URL,
        model: config.EXTRACTION_MODEL,
        preferJsonMode: config.EXTRACTION_PREFER_JSON_MODE,
      }),
      new RuleBasedExtractionProvider(),
    );
  }

  const wantsClaude =
    config.EXTRACTION_PROVIDER === "claude" ||
    (config.EXTRACTION_PROVIDER === "auto" && Boolean(config.ANTHROPIC_API_KEY));

  if (wantsClaude) {
    return new FallbackExtractionProvider(
      new ClaudeExtractionProvider({
        apiKey: config.ANTHROPIC_API_KEY,
        baseUrl: config.ANTHROPIC_BASE_URL,
        model: config.EXTRACTION_MODEL,
        effort: config.EXTRACTION_EFFORT,
      }),
      new RuleBasedExtractionProvider(),
    );
  }

  return new RuleBasedExtractionProvider();
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});
