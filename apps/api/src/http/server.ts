import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import cors from "@fastify/cors";
import { z } from "zod";
import { OverrideReason, IncidentStatus } from "@resqai/schema";

import { channelReadiness, type Config } from "../config.js";
import type { Db } from "../db/driver.js";
import {
  ConcurrencyConflict,
  IncidentNotFound,
  UnknownField,
  UnknownLocationCandidate,
} from "../domain/errors.js";
import { UnsupportedPayload } from "../intake/adapters.js";
import type { IntakePipeline } from "../pipeline/intake.js";
import type { UnitRepository } from "../units/repository.js";
import type { DispatchService } from "../units/dispatch.js";
import type { IncidentNotifier } from "../realtime/notifier.js";
import {
  AuthFailed,
  Forbidden,
  hasRole,
  type OperatorService,
  type Role,
} from "../auth/operators.js";
import {
  REVIEWABLE_FIELDS,
  type IncidentRepository,
  type IncidentRow,
} from "../repository/incidents.js";
import {
  OperatorRegistry,
  RateLimiter,
  verifyTwilioSignature,
  verifyWhatsAppChallenge,
  verifyWhatsAppSignature,
  type Operator,
} from "./auth.js";

/**
 * The HTTP surface.
 *
 * Three kinds of route, with different rules:
 *
 *  - **Webhooks** are authenticated by provider signature over the raw body.
 *    A channel with no configured secret is refused rather than served
 *    unverified — an open intake endpoint accepts fabricated emergencies.
 *  - **Operator routes** need a bearer token, because every confirmation and
 *    override records who made it.
 *  - **Health routes** are open, and deliberately reveal nothing beyond
 *    liveness and readiness.
 */

declare module "fastify" {
  interface FastifyRequest {
    rawBody?: Buffer;
    operator?: { id: string; role?: string; session_id?: string };
  }
}

export interface ServerDeps {
  config: Config;
  db: Db;
  repo: IncidentRepository;
  pipeline: IntakePipeline;
  /** Omit to disable the dispatch routes entirely. */
  units?: UnitRepository;
  dispatch?: DispatchService;
  /** Omit to disable the live-update stream. */
  notifier?: IncidentNotifier;
  /**
   * Database-backed operator accounts.
   *
   * When present it takes precedence over `OPERATOR_TOKENS`, which stays as a
   * fallback so an existing deployment keeps working while accounts are
   * created. Once every operator has one, drop the env var.
   */
  operators?: OperatorService;
}

export function buildServer(deps: ServerDeps): FastifyInstance {
  const { config, db, repo, pipeline, units, dispatch, notifier, operators: accounts } = deps;

  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: {
        // Signatures and tokens must never reach the logs. Neither must a
        // caller's phone number, which arrives in webhook bodies as personal
        // data under the DPDP Act.
        paths: [
          "req.headers.authorization",
          "req.headers['x-hub-signature-256']",
          "req.headers['x-twilio-signature']",
        ],
        remove: true,
      },
    },
    // Trust the proxy for client IPs so rate limiting keys on the real caller
    // rather than on a single load-balancer address.
    trustProxy: true,
    bodyLimit: 1_000_000,
  });

  const operators = new OperatorRegistry(config.OPERATOR_TOKENS);
  const webhookLimiter = new RateLimiter(120, 60_000);
  // Far tighter than the webhook limit. A control room signs in a handful of
  // times a shift; anything approaching this rate is someone guessing.
  const signInLimiter = new RateLimiter(10, 60_000);
  const channels = channelReadiness(config);

  /* ---------------- CORS ---------------- */

  /**
   * An allowlist, never a wildcard.
   *
   * The console sends an `Authorization` header on every call, and `*` cannot
   * be combined with credentials anyway — but the real reason is narrower: a
   * wildcard would let any page a call-taker happens to have open make
   * authenticated requests with their operator token.
   *
   * Webhooks are unaffected. Providers post server-to-server and never send an
   * `Origin` header, so refusing unknown browser origins costs nothing there.
   */
  const allowedOrigins = config.CONSOLE_ORIGINS.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  void app.register(cors, {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
    allowedHeaders: ["content-type", "authorization"],
    credentials: true,
    maxAge: 600,
  });

  /* ---------------- raw body ---------------- */

  // Signature verification needs the exact bytes the provider signed.
  // `JSON.stringify(JSON.parse(body))` is not byte-identical — key order,
  // whitespace and unicode escaping all differ — so re-serialising would fail
  // verification for legitimate requests.
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (req, body, done) => {
      req.rawBody = body as Buffer;
      try {
        done(null, JSON.parse((body as Buffer).toString("utf8")));
      } catch {
        done(new SyntaxError("invalid JSON body"), undefined);
      }
    },
  );

  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "buffer" },
    (req, body, done) => {
      req.rawBody = body as Buffer;
      const params = new URLSearchParams((body as Buffer).toString("utf8"));
      done(null, Object.fromEntries(params));
    },
  );

  /* ---------------- errors ---------------- */

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof IncidentNotFound) {
      return reply.status(404).send({ error: "incident_not_found" });
    }
    if (error instanceof ConcurrencyConflict) {
      // 409 rather than a silent retry: two operators editing one incident is
      // a coordination problem the console must surface, not resolve by coin toss.
      return reply.status(409).send({
        error: "version_conflict",
        message: error.message,
        expected_version: error.expectedVersion,
        actual_version: error.actualVersion,
      });
    }
    if (error instanceof AuthFailed) {
      // Deliberately uninformative. The real reason is in auth_events, where
      // only a defender reads it.
      return reply.status(401).send({ error: "sign_in_failed" });
    }
    if (error instanceof Forbidden) {
      // 403, not 401: the caller is authenticated and simply not permitted.
      // Returning 401 would send a signed-in operator back to a login screen
      // that cannot help them.
      return reply.status(403).send({ error: "forbidden", message: error.message });
    }
    if (error instanceof UnknownLocationCandidate) {
      // 409 rather than 400: the request was well-formed against the candidate
      // list the console was holding, which has since been re-resolved. The fix
      // is to re-read the incident, not to correct the request.
      return reply.status(409).send({
        error: "stale_location_candidates",
        message: error.message,
        available: error.available,
      });
    }
    if (error instanceof UnknownField || error instanceof UnsupportedPayload) {
      return reply.status(400).send({ error: "bad_request", message: error.message });
    }
    if (error instanceof SyntaxError) {
      return reply.status(400).send({ error: "invalid_body" });
    }

    request.log.error({ err: error }, "unhandled error");
    // Never leak internals to the caller.
    return reply.status(500).send({ error: "internal_error" });
  });

  /* ---------------- health ---------------- */

  app.get("/health", async () => ({ status: "ok" }));

  app.get("/ready", async (_request, reply) => {
    try {
      await db.query("SELECT 1");
    } catch {
      return reply.status(503).send({ status: "degraded", database: "unreachable" });
    }
    return {
      status: "ok",
      database: "ok",
      channels,
      operators_configured: operators.size,
    };
  });

  /* ---------------- operator guard ---------------- */

  /**
   * Resolves the caller.
   *
   * Database-backed sessions first; the environment tokens are consulted only
   * when no account matches, so a deployment mid-migration keeps working while
   * accounts are created. An env token carries the lowest role — it cannot be
   * revoked, so it should not be able to release a legal hold.
   */
  const identify = async (
    request: FastifyRequest,
  ): Promise<{ id: string; role: Role; session_id?: string } | null> => {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) return null;

    const token = header.slice("Bearer ".length).trim();

    if (accounts) {
      const operator = await accounts.resolve(token);
      if (operator) {
        return {
          id: operator.id,
          role: operator.role,
          session_id: operator.session_id,
        };
      }
    }

    const legacy = operators.resolve(header);
    return legacy?.id ? { id: legacy.id, role: "call_taker" } : null;
  };

  const requireOperator = async (
    request: FastifyRequest,
    reply: { status: (n: number) => { send: (b: unknown) => unknown } },
  ) => {
    const operator = await identify(request);
    if (!operator) {
      reply.status(401).send({ error: "unauthorised" });
      return reply;
    }
    request.operator = operator;
    return undefined;
  };

  /** Guards an action behind a minimum role. */
  const requireRole =
    (required: Role) =>
    async (
      request: FastifyRequest,
      reply: { status: (n: number) => { send: (b: unknown) => unknown } },
    ) => {
      const operator = await identify(request);
      if (!operator) {
        reply.status(401).send({ error: "unauthorised" });
        return reply;
      }
      if (!hasRole(operator.role, required)) {
        reply.status(403).send({
          error: "forbidden",
          message: `This action requires the ${required} role`,
        });
        return reply;
      }
      request.operator = operator;
      return undefined;
    };

  /* ---------------- sessions ---------------- */

  const Credentials = z.object({
    operator_id: z.string().min(1).max(120),
    password: z.string().min(1).max(400),
  });

  app.post("/auth/sign-in", async (request, reply) => {
    if (!accounts) {
      return reply.status(503).send({ error: "accounts_not_configured" });
    }

    // Rate limited by source, because this is the one unauthenticated endpoint
    // where guessing is the attack.
    if (!signInLimiter.check(`auth:${request.ip}`)) {
      return reply.status(429).send({ error: "rate_limited" });
    }

    const body = Credentials.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: "invalid_credentials_format" });
    }

    const { token, operator } = await accounts.signIn(
      body.data.operator_id,
      body.data.password,
      {
        ip: request.ip,
        userAgent: request.headers["user-agent"] ?? null,
      },
    );

    return {
      token,
      operator: {
        id: operator.id,
        display_name: operator.display_name,
        role: operator.role,
        must_change_password: operator.must_change_password,
      },
    };
  });

  app.post("/auth/sign-out", { preHandler: requireOperator }, async (request) => {
    const sessionId = request.operator?.session_id;
    if (accounts && sessionId) {
      await accounts.signOut(sessionId, request.operator!.id);
    }
    return { signed_out: true };
  });

  app.get("/auth/me", { preHandler: requireOperator }, async (request) => {
    return { operator: request.operator };
  });

  /* ---------------- WhatsApp ---------------- */

  // Meta's registration handshake: echo the challenge back as plain text.
  app.get("/webhooks/whatsapp", async (request, reply) => {
    if (!config.WHATSAPP_VERIFY_TOKEN) {
      return reply.status(503).send({ error: "whatsapp_not_configured" });
    }
    const result = verifyWhatsAppChallenge(
      request.query as Record<string, unknown>,
      config.WHATSAPP_VERIFY_TOKEN,
    );
    if (!result.ok) return reply.status(403).send({ error: "verification_failed" });

    return reply.type("text/plain").send(result.challenge);
  });

  app.post("/webhooks/whatsapp", async (request, reply) => {
    if (!channels.whatsapp) {
      // Refused rather than accepted unverified. An intake endpoint without a
      // signing secret accepts fabricated emergencies from anyone.
      return reply.status(503).send({ error: "whatsapp_not_configured" });
    }

    if (!webhookLimiter.check(`wa:${request.ip}`)) {
      return reply.status(429).send({ error: "rate_limited" });
    }

    const signature = verifyWhatsAppSignature(
      request.rawBody ?? Buffer.alloc(0),
      request.headers["x-hub-signature-256"] as string | undefined,
      config.WHATSAPP_APP_SECRET!,
    );

    if (!signature.valid) {
      request.log.warn({ reason: signature.reason }, "rejected WhatsApp webhook");
      return reply.status(401).send({ error: "invalid_signature" });
    }

    const results = await pipeline.handle("whatsapp", request.body);

    // 200 means the messages are stored. Extraction may still have failed —
    // that is recorded on the incident and surfaced as degraded, not as a
    // delivery failure, because a retry would not help and would be rejected
    // as a duplicate anyway.
    return reply.status(200).send({ received: results.length, results });
  });

  /* ---------------- SMS ---------------- */

  app.post("/webhooks/sms", async (request, reply) => {
    if (!channels.sms) {
      return reply.status(503).send({ error: "sms_not_configured" });
    }

    if (!webhookLimiter.check(`sms:${request.ip}`)) {
      return reply.status(429).send({ error: "rate_limited" });
    }

    const signature = verifyTwilioSignature(
      `${config.PUBLIC_URL}/webhooks/sms`,
      (request.body ?? {}) as Record<string, string>,
      request.headers["x-twilio-signature"] as string | undefined,
      config.TWILIO_AUTH_TOKEN!,
    );

    if (!signature.valid) {
      request.log.warn({ reason: signature.reason }, "rejected SMS webhook");
      return reply.status(401).send({ error: "invalid_signature" });
    }

    const results = await pipeline.handle("sms", request.body);
    return reply.status(200).send({ received: results.length, results });
  });

  /* ---------------- web intake ---------------- */

  const WebSubmission = z.object({
    submissionId: z.string().min(1).max(200),
    message: z.string().min(1).max(4000),
    sessionId: z.string().max(200).optional(),
    contact: z.string().max(64).optional(),
  });

  app.post("/intake/web", async (request, reply) => {
    if (!webhookLimiter.check(`web:${request.ip}`)) {
      return reply.status(429).send({ error: "rate_limited" });
    }

    const parsed = WebSubmission.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "invalid_submission",
        issues: parsed.error.issues.map((i) => ({
          field: i.path.join("."),
          message: i.message,
        })),
      });
    }

    const results = await pipeline.handle("web", parsed.data);
    const first = results[0];

    return reply.status(first ? 201 : 200).send({
      reference: first?.reference ?? null,
      incident_id: first?.incidentId ?? null,
      duplicate: first?.duplicate ?? false,
    });
  });

  /* ---------------- incidents (operator) ---------------- */

  app.get(
    "/incidents",
    { preHandler: requireOperator },
    async (request) => {
      const query = request.query as { limit?: string };
      const limit = Math.min(Number(query.limit ?? 100) || 100, 200);
      const rows = await repo.listQueue(limit);
      return { incidents: rows.map(summarise) };
    },
  );

  app.get(
    "/incidents/:id",
    { preHandler: requireOperator },
    async (request) => {
      const { id } = request.params as { id: string };
      const incident = await repo.requireById(id);
      return { incident };
    },
  );

  app.get(
    "/incidents/:id/transcript",
    { preHandler: requireOperator },
    async (request) => {
      const { id } = request.params as { id: string };
      await repo.requireById(id);
      return { segments: await repo.listSegments(id) };
    },
  );

  app.get(
    "/incidents/:id/audit",
    { preHandler: requireOperator },
    async (request) => {
      const { id } = request.params as { id: string };
      await repo.requireById(id);
      return {
        events: await repo.auditTrail(id),
        extraction_passes: await repo.listExtractionPasses(id),
      };
    },
  );

  /* ---------------- operator actions ---------------- */

  const VersionedBody = z.object({ version: z.number().int().nonnegative() });

  app.post(
    "/incidents/:id/fields/:field/confirm",
    { preHandler: requireOperator },
    async (request, reply) => {
      const { id, field } = request.params as { id: string; field: string };
      const body = VersionedBody.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: "version_required" });
      }

      const updated = await repo.confirmField(
        id,
        body.data.version,
        field,
        request.operator!,
      );
      return { incident: summarise(updated), version: updated.version };
    },
  );

  const OverrideBody = z.object({
    version: z.number().int().nonnegative(),
    // Unknown rather than a narrow type: each field carries a different value
    // shape, and the schema validates it downstream.
    value: z.unknown(),
    reason: OverrideReason,
  });

  app.post(
    "/incidents/:id/fields/:field/override",
    { preHandler: requireOperator },
    async (request, reply) => {
      const { id, field } = request.params as { id: string; field: string };
      const body = OverrideBody.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({
          error: "invalid_override",
          issues: body.error.issues.map((i) => ({
            field: i.path.join("."),
            message: i.message,
          })),
          reviewable_fields: REVIEWABLE_FIELDS,
        });
      }

      const updated = await repo.overrideField(
        id,
        body.data.version,
        field,
        body.data.value,
        body.data.reason,
        request.operator!,
      );
      return { incident: summarise(updated), version: updated.version };
    },
  );

  const StatusBody = z.object({
    version: z.number().int().nonnegative(),
    status: IncidentStatus,
  });

  app.post(
    "/incidents/:id/status",
    { preHandler: requireOperator },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = StatusBody.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: "invalid_status" });
      }

      const updated = await repo.setStatus(
        id,
        body.data.version,
        body.data.status,
        request.operator!,
      );
      return { incident: summarise(updated), version: updated.version };
    },
  );

  /* ---------------- location ---------------- */

  app.get(
    "/incidents/:id/location",
    { preHandler: requireOperator },
    async (request) => {
      const { id } = request.params as { id: string };
      const incident = await repo.requireById(id);
      return {
        location: incident.location,
        ambiguity: incident.location_ambiguity,
        // Repeated at the top level because it is the question the console has
        // to answer before any dispatch control becomes usable.
        confirmed:
          (incident.location as { selected_index?: number | null }).selected_index !== null,
      };
    },
  );

  const SelectCandidate = z.object({
    version: z.number().int().nonnegative(),
    candidate_index: z.number().int().nonnegative(),
  });

  app.post(
    "/incidents/:id/location/select",
    { preHandler: requireOperator },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = SelectCandidate.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: "invalid_selection" });
      }

      const updated = await repo.selectLocationCandidate(
        id,
        body.data.version,
        body.data.candidate_index,
        request.operator!,
      );

      return {
        incident: summarise(updated),
        location: updated.location,
        version: updated.version,
      };
    },
  );

  /* ---------------- dispatch ---------------- */

  app.get(
    "/incidents/:id/units",
    { preHandler: requireOperator },
    async (request, reply) => {
      if (!dispatch) {
        return reply.status(503).send({ error: "dispatch_not_configured" });
      }

      const { id } = request.params as { id: string };
      const incident = await repo.requireById(id);

      const agencies =
        ((incident.fields.agencies as { value?: string[] } | undefined)?.value ??
          []) as never[];

      const recommendation = await dispatch.recommend({
        location: incident.location as never,
        agencies,
        priority: incident.priority_code,
      });

      // 200 with an empty list and a reason, not 404. "We do not know where
      // this is" and "no ambulance is free" are both valid answers to this
      // question and both need to reach the operator as answers.
      return {
        units: recommendation.units,
        from: recommendation.from,
        blocked_reason: recommendation.blocked_reason,
        degraded_routing: recommendation.degraded_routing,
      };
    },
  );

  const DispatchBody = z.object({
    version: z.number().int().nonnegative(),
    unit_id: z.string().min(1).max(120),
  });

  app.post(
    "/incidents/:id/dispatch",
    { preHandler: requireOperator },
    async (request, reply) => {
      if (!units || !dispatch) {
        return reply.status(503).send({ error: "dispatch_not_configured" });
      }

      const { id } = request.params as { id: string };
      const body = DispatchBody.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({ error: "invalid_dispatch" });
      }

      const incident = await repo.requireById(id);

      // The location gate again, enforced at the boundary rather than trusted
      // from the client. A console bug must not be able to dispatch against an
      // unconfirmed location.
      const location = incident.location as { selected_index?: number | null };
      if (location.selected_index === null || location.selected_index === undefined) {
        return reply.status(409).send({
          error: "location_not_confirmed",
          message: "Confirm the incident location before dispatching a unit.",
        });
      }

      const dispatched = await units.markDispatched(
        id,
        body.data.unit_id,
        request.operator!.id ?? "unknown",
      );

      if (!dispatched) {
        return reply.status(409).send({
          error: "not_recommended_or_already_dispatched",
          message:
            "That unit was not among the recommendations for this incident, or has already been dispatched to it.",
        });
      }

      return { dispatched: true, unit_id: body.data.unit_id };
    },
  );

  app.get("/units", { preHandler: requireOperator }, async () => {
    if (!units) return { units: [], configured: false };
    return { count: await units.count(), configured: true };
  });

  /* ---------------- live updates ---------------- */

  /**
   * Server-sent events for the console queue.
   *
   * Authenticated by `Authorization` header like every other operator route,
   * which means the console must consume this with `fetch` and a stream reader
   * rather than `EventSource` — `EventSource` cannot set headers, and the
   * alternative is putting an operator token in a query string where every
   * proxy, access log and browser history entry would keep a copy.
   *
   * The payload deliberately carries only identifiers and queue-level fields.
   * A client receives "incident X changed" and re-reads through the
   * authenticated API, so nothing here can leak a transcript or a caller hash
   * to a listener who should not see one.
   */
  app.get("/events", { preHandler: requireOperator }, async (request, reply) => {
    if (!notifier) {
      return reply.status(503).send({ error: "live_updates_not_configured" });
    }

    /*
     * CORS headers are set by hand here, and that is not redundant.
     *
     * `reply.raw.writeHead` writes straight to the socket, bypassing every
     * Fastify hook — including the CORS plugin's. The response then arrives
     * complete and correct with no `Access-Control-Allow-Origin`, and the
     * browser discards it without surfacing anything useful: the stream simply
     * never delivers, which is indistinguishable from a quiet shift.
     *
     * The origin is matched against the same allowlist rather than echoed, so
     * taking over the socket does not also take over the access rules.
     */
    const origin = request.headers.origin;
    const corsHeaders =
      origin && allowedOrigins.includes(origin)
        ? {
            "access-control-allow-origin": origin,
            "access-control-allow-credentials": "true",
            vary: "Origin",
          }
        : {};

    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Nginx buffers text/event-stream by default, which turns a live feed
      // into a feed that arrives in bursts when the buffer fills.
      "x-accel-buffering": "no",
      ...corsHeaders,
    });

    // Tell Fastify the socket is ours now, so it does not try to send its own
    // response or run onSend hooks against a stream that is already flowing.
    reply.hijack();

    const send = (event: string, data: unknown) => {
      // A write to a closed socket throws; the disconnect handler may not have
      // run yet when the client vanishes mid-flush.
      try {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        cleanup();
      }
    };

    const onIncident = (payload: unknown) => send("incident", payload);

    // Tells the console whether it is receiving live updates or should fall
    // back to polling. A stream that is open but not connected to the database
    // looks identical to a quiet shift, which is the worst way to fail.
    send("hello", { live: notifier.connected, at: new Date().toISOString() });

    notifier.on("incident", onIncident);

    // Proxies and load balancers close idle connections, typically at 60s.
    // A comment line is a valid SSE no-op that keeps the connection warm
    // without the client having to interpret anything.
    const heartbeat = setInterval(() => {
      try {
        reply.raw.write(`: keep-alive ${Date.now()}\n\n`);
      } catch {
        cleanup();
      }
    }, 25_000);

    let cleaned = false;
    function cleanup() {
      if (cleaned) return;
      cleaned = true;
      clearInterval(heartbeat);
      notifier?.off("incident", onIncident);
      reply.raw.end();
    }

    request.raw.on("close", cleanup);
    request.raw.on("error", cleanup);

    // The socket is hijacked; there is nothing left for Fastify to send.
    return;
  });

  return app;
}

/**
 * The queue projection.
 *
 * Deliberately excludes the full field envelopes and the caller hash: a list
 * view does not need them, and the less personal data crosses the wire the
 * less there is to leak. The detail route returns the whole incident.
 */
function summarise(row: IncidentRow) {
  return {
    incident_id: row.incident_id,
    reference: row.reference,
    status: row.status,
    channel: row.channel,
    language: row.primary_language,
    priority: row.priority_code,
    incident_type: row.incident_type_code,
    summary: row.summary,
    escalation_triggers: row.escalation_triggers,
    degraded_mode: row.degraded_mode,
    overall_confidence: row.overall_confidence,
    received_at: row.received_at,
    version: row.version,
    // Whether the location is pinned down is queue-level information: it
    // decides whether this incident can be dispatched at all.
    location_confirmed:
      (row.location as { selected_index?: number | null }).selected_index !== null,
    location_ambiguity: row.location_ambiguity,
  };
}
