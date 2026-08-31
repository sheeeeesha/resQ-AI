import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import type { FastifyInstance } from "fastify";

import { createHarness, type Harness } from "../test-support/harness.js";
import { buildServer } from "./server.js";
import { IntakePipeline } from "../pipeline/intake.js";
import { ExtractionService } from "../extraction/service.js";
import { RuleBasedExtractionProvider } from "../extraction/rule-based.js";
import { loadConfig, type Config } from "../config.js";
import { OperatorService } from "../auth/operators.js";
import { UnitRepository } from "../units/repository.js";
import { DispatchService } from "../units/dispatch.js";
import { StraightLineRouter } from "../units/routing.js";

const APP_SECRET = "meta-app-secret";
const TWILIO_TOKEN = "twilio-auth-token";
const OP_TOKEN = "operator-token-abc";

const BASE_ENV = {
  DATABASE_URL: "postgresql://unused:unused@localhost:5432/unused",
  CALLER_NUMBER_SALT: "d".repeat(32),
  WHATSAPP_APP_SECRET: APP_SECRET,
  WHATSAPP_VERIFY_TOKEN: "verify-me",
  TWILIO_AUTH_TOKEN: TWILIO_TOKEN,
  PUBLIC_URL: "https://api.example.in",
  OPERATOR_TOKENS: `${OP_TOKEN}:op-1`,
  LOG_LEVEL: "error",
} as unknown as NodeJS.ProcessEnv;

interface Ctx {
  h: Harness;
  app: FastifyInstance;
  config: Config;
}

async function withServer(
  fn: (ctx: Ctx) => Promise<void>,
  envOverrides: Record<string, string | undefined> = {},
): Promise<void> {
  const h = await createHarness();
  const config = loadConfig({ ...BASE_ENV, ...envOverrides } as NodeJS.ProcessEnv);

  const units = new UnitRepository(h.db);
  const app = buildServer({
    config,
    db: h.db,
    repo: h.repo,
    units,
    dispatch: new DispatchService(units, new StraightLineRouter()),
    pipeline: new IntakePipeline({
      repo: h.repo,
      extraction: new ExtractionService({ provider: new RuleBasedExtractionProvider() }),
      callerSalt: config.CALLER_NUMBER_SALT!,
      referencePrefix: "TS",
    }),
  });

  try {
    await fn({ h, app, config });
  } finally {
    await app.close();
    await h.close();
  }
}

/** A second server sharing the harness, with database-backed accounts on. */
function buildServerWithAccounts(ctx: Ctx, accounts: OperatorService) {
  const units = new UnitRepository(ctx.h.db);
  return buildServer({
    config: ctx.config,
    db: ctx.h.db,
    repo: ctx.h.repo,
    units,
    dispatch: new DispatchService(units, new StraightLineRouter()),
    operators: accounts,
    pipeline: new IntakePipeline({
      repo: ctx.h.repo,
      extraction: new ExtractionService({ provider: new RuleBasedExtractionProvider() }),
      callerSalt: ctx.config.CALLER_NUMBER_SALT!,
      referencePrefix: "TS",
    }),
  });
}

let counter = 0;
function whatsAppBody(text: string, from = "919876543210"): string {
  counter += 1;
  return JSON.stringify({
    entry: [
      {
        changes: [
          {
            value: {
              messages: [
                {
                  id: `wamid.HTTP${counter}`,
                  from,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: "text",
                  text: { body: text },
                },
              ],
            },
          },
        ],
      },
    ],
  });
}

function sign(body: string, secret = APP_SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

const auth = { authorization: `Bearer ${OP_TOKEN}` };

/* ------------------------------------------------------------------ *
 * Health
 * ------------------------------------------------------------------ */

test("health is open and says nothing useful to an attacker", async () => {
  await withServer(async ({ app }) => {
    const res = await app.inject({ method: "GET", url: "/health" });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { status: "ok" });
  });
});

test("ready reports which channels are actually usable", async () => {
  await withServer(async ({ app }) => {
    const res = await app.inject({ method: "GET", url: "/ready" });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.database, "ok");
    assert.deepEqual(body.channels, { whatsapp: true, sms: true });
    assert.equal(body.operators_configured, 1);
  });
});

/* ------------------------------------------------------------------ *
 * WhatsApp signature
 * ------------------------------------------------------------------ */

test("a correctly signed WhatsApp webhook is accepted", async () => {
  await withServer(async ({ app, h }) => {
    const body = whatsAppBody("aag lag gayi hai building mein");

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/whatsapp",
      headers: { "content-type": "application/json", "x-hub-signature-256": sign(body) },
      payload: body,
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().received, 1);

    const queue = await h.repo.listQueue();
    assert.equal(queue.length, 1);
    assert.equal(queue[0]!.incident_type_code, "fire_structure");
  });
});

test("an unsigned webhook is rejected and stores nothing", async () => {
  await withServer(async ({ app, h }) => {
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/whatsapp",
      headers: { "content-type": "application/json" },
      payload: whatsAppBody("fabricated emergency"),
    });

    assert.equal(res.statusCode, 401);
    // The prototype's intake was completely open. Nothing unauthenticated may
    // reach the database.
    assert.equal((await h.repo.listQueue()).length, 0);
  });
});

test("a signature from the wrong secret is rejected", async () => {
  await withServer(async ({ app, h }) => {
    const body = whatsAppBody("fabricated emergency");
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/whatsapp",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": sign(body, "attacker-secret"),
      },
      payload: body,
    });

    assert.equal(res.statusCode, 401);
    assert.equal((await h.repo.listQueue()).length, 0);
  });
});

test("a tampered body invalidates the signature", async () => {
  await withServer(async ({ app, h }) => {
    const original = whatsAppBody("small fire");
    const signature = sign(original);

    // Same signature, different body — the classic replay-with-edit.
    const tampered = original.replace("small fire", "massive explosion downtown");

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/whatsapp",
      headers: { "content-type": "application/json", "x-hub-signature-256": signature },
      payload: tampered,
    });

    assert.equal(res.statusCode, 401);
    assert.equal((await h.repo.listQueue()).length, 0);
  });
});

test("a malformed signature header is rejected", async () => {
  await withServer(async ({ app }) => {
    const body = whatsAppBody("test");
    for (const header of ["garbage", "sha1=abc", "sha256=", ""]) {
      const res = await app.inject({
        method: "POST",
        url: "/webhooks/whatsapp",
        headers: { "content-type": "application/json", "x-hub-signature-256": header },
        payload: body,
      });
      assert.equal(res.statusCode, 401, `header "${header}" should be rejected`);
    }
  });
});

test("an unconfigured channel is refused, never served unverified", async () => {
  await withServer(
    async ({ app, h }) => {
      const body = whatsAppBody("test");
      const res = await app.inject({
        method: "POST",
        url: "/webhooks/whatsapp",
        headers: { "content-type": "application/json", "x-hub-signature-256": sign(body) },
        payload: body,
      });

      // Accepting this unverified would make it an open intake endpoint.
      assert.equal(res.statusCode, 503);
      assert.equal(res.json().error, "whatsapp_not_configured");
      assert.equal((await h.repo.listQueue()).length, 0);
    },
    { WHATSAPP_APP_SECRET: undefined },
  );
});

/* ------------------------------------------------------------------ *
 * WhatsApp registration handshake
 * ------------------------------------------------------------------ */

test("the verification challenge is echoed as plain text", async () => {
  await withServer(async ({ app }) => {
    const res = await app.inject({
      method: "GET",
      url: "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=1158201444",
    });

    assert.equal(res.statusCode, 200);
    // Meta expects the raw challenge, not JSON.
    assert.equal(res.body, "1158201444");
  });
});

test("a wrong verify token fails the handshake", async () => {
  await withServer(async ({ app }) => {
    const res = await app.inject({
      method: "GET",
      url: "/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=123",
    });
    assert.equal(res.statusCode, 403);
  });
});

/* ------------------------------------------------------------------ *
 * Twilio
 * ------------------------------------------------------------------ */

test("a correctly signed Twilio webhook is accepted", async () => {
  await withServer(async ({ app, h }) => {
    const params = {
      MessageSid: "SM-http-1",
      From: "+919812345678",
      Body: "road accident near the flyover",
    };

    const payload = Object.keys(params)
      .sort()
      .reduce(
        (acc, k) => acc + k + params[k as keyof typeof params],
        "https://api.example.in/webhooks/sms",
      );
    const signature = createHmac("sha1", TWILIO_TOKEN).update(payload).digest("base64");

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/sms",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": signature,
      },
      payload: new URLSearchParams(params).toString(),
    });

    assert.equal(res.statusCode, 200);
    assert.equal((await h.repo.listQueue()).length, 1);
  });
});

test("an unsigned Twilio webhook is rejected", async () => {
  await withServer(async ({ app, h }) => {
    const res = await app.inject({
      method: "POST",
      url: "/webhooks/sms",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ MessageSid: "S1", From: "+91987", Body: "x" }).toString(),
    });

    assert.equal(res.statusCode, 401);
    assert.equal((await h.repo.listQueue()).length, 0);
  });
});

/* ------------------------------------------------------------------ *
 * Web intake
 * ------------------------------------------------------------------ */

test("a web submission creates an incident and returns its reference", async () => {
  await withServer(async ({ app }) => {
    const res = await app.inject({
      method: "POST",
      url: "/intake/web",
      payload: { submissionId: "web-http-1", message: "there is a fire in the market" },
    });

    assert.equal(res.statusCode, 201);
    assert.match(res.json().reference, /^TS-\d{8}-[0-9A-F]{6}$/);
  });
});

test("a resubmitted web form is reported as a duplicate", async () => {
  await withServer(async ({ app, h }) => {
    const payload = { submissionId: "web-dupe", message: "building collapsed" };

    await app.inject({ method: "POST", url: "/intake/web", payload });
    const second = await app.inject({ method: "POST", url: "/intake/web", payload });

    assert.equal(second.json().duplicate, true);
    assert.equal((await h.repo.listSegments(second.json().incident_id)).length, 1);
  });
});

test("an invalid web submission is rejected with field detail", async () => {
  await withServer(async ({ app }) => {
    const res = await app.inject({
      method: "POST",
      url: "/intake/web",
      payload: { message: "" },
    });

    assert.equal(res.statusCode, 400);
    const issues = res.json().issues as Array<{ field: string }>;
    assert.ok(issues.some((i) => i.field === "submissionId"));
  });
});

/* ------------------------------------------------------------------ *
 * Operator authentication
 * ------------------------------------------------------------------ */

test("operator routes reject an absent or wrong token", async () => {
  await withServer(async ({ app }) => {
    assert.equal((await app.inject({ method: "GET", url: "/incidents" })).statusCode, 401);

    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: "/incidents",
          headers: { authorization: "Bearer wrong-token" },
        })
      ).statusCode,
      401,
    );

    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: "/incidents",
          headers: { authorization: OP_TOKEN }, // missing "Bearer "
        })
      ).statusCode,
      401,
    );
  });
});

test("a valid operator token reaches the queue", async () => {
  await withServer(async ({ app }) => {
    const res = await app.inject({ method: "GET", url: "/incidents", headers: auth });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().incidents, []);
  });
});

/* ------------------------------------------------------------------ *
 * Reading and acting on an incident
 * ------------------------------------------------------------------ */

async function seedIncident(ctx: Ctx): Promise<string> {
  const body = whatsAppBody("aag lag gayi hai, bachcha andar phansa hai");
  const res = await ctx.app.inject({
    method: "POST",
    url: "/webhooks/whatsapp",
    headers: { "content-type": "application/json", "x-hub-signature-256": sign(body) },
    payload: body,
  });
  return res.json().results[0].incidentId as string;
}

test("an incident is readable with its transcript and audit trail", async () => {
  await withServer(async (ctx) => {
    const id = await seedIncident(ctx);

    const incident = await ctx.app.inject({
      method: "GET",
      url: `/incidents/${id}`,
      headers: auth,
    });
    assert.equal(incident.statusCode, 200);
    assert.equal(incident.json().incident.incident_type_code, "fire_structure");

    const transcript = await ctx.app.inject({
      method: "GET",
      url: `/incidents/${id}/transcript`,
      headers: auth,
    });
    assert.equal(transcript.json().segments.length, 1);

    const audit = await ctx.app.inject({
      method: "GET",
      url: `/incidents/${id}/audit`,
      headers: auth,
    });
    const types = (audit.json().events as Array<{ type: string }>).map((e) => e.type);
    assert.ok(types.includes("incident_created"));
    assert.ok(types.includes("extraction_completed"));
    assert.equal(audit.json().extraction_passes.length, 1);
  });
});

test("the queue projection withholds the caller hash and field envelopes", async () => {
  await withServer(async (ctx) => {
    await seedIncident(ctx);
    const res = await ctx.app.inject({ method: "GET", url: "/incidents", headers: auth });
    const [row] = res.json().incidents;

    // A list view has no need of these, and less personal data on the wire is
    // less to leak.
    assert.equal(row.caller_number_hash, undefined);
    assert.equal(row.fields, undefined);
    assert.ok(row.reference);
    assert.ok(row.priority);
  });
});

test("an override records the operator and survives", async () => {
  await withServer(async (ctx) => {
    const id = await seedIncident(ctx);
    const before = await ctx.h.repo.requireById(id);

    const res = await ctx.app.inject({
      method: "POST",
      url: `/incidents/${id}/fields/incident_type/override`,
      headers: auth,
      payload: {
        version: before.version,
        value: "crime_assault",
        reason: "wrong_classification",
      },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().incident.incident_type, "crime_assault");

    const trail = await ctx.h.repo.auditTrail(id);
    const override = trail.find((e) => e.type === "field_overridden")!;
    assert.equal(override.actor, "op-1");
  });
});

test("a stale version is a 409, not a silent overwrite", async () => {
  await withServer(async (ctx) => {
    const id = await seedIncident(ctx);
    const before = await ctx.h.repo.requireById(id);

    await ctx.app.inject({
      method: "POST",
      url: `/incidents/${id}/fields/priority/confirm`,
      headers: auth,
      payload: { version: before.version },
    });

    // Second operator still holds the stale version.
    const res = await ctx.app.inject({
      method: "POST",
      url: `/incidents/${id}/fields/priority/confirm`,
      headers: auth,
      payload: { version: before.version },
    });

    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error, "version_conflict");
    // The console needs both numbers to show the operator what happened.
    assert.equal(res.json().expected_version, before.version);
    assert.ok(res.json().actual_version > before.version);
  });
});

test("an unknown field name is a 400 listing what is reviewable", async () => {
  await withServer(async (ctx) => {
    const id = await seedIncident(ctx);
    const before = await ctx.h.repo.requireById(id);

    const res = await ctx.app.inject({
      method: "POST",
      url: `/incidents/${id}/fields/criticality/override`,
      headers: auth,
      payload: { version: before.version, value: "High", reason: "wrong_severity" },
    });

    assert.equal(res.statusCode, 400);
  });
});

test("an invalid override reason is rejected", async () => {
  await withServer(async (ctx) => {
    const id = await seedIncident(ctx);
    const before = await ctx.h.repo.requireById(id);

    const res = await ctx.app.inject({
      method: "POST",
      url: `/incidents/${id}/fields/priority/override`,
      headers: auth,
      payload: { version: before.version, value: "P0_immediate", reason: "because i said so" },
    });

    assert.equal(res.statusCode, 400);
    assert.ok((res.json().reviewable_fields as string[]).includes("priority"));
  });
});

test("a missing incident is a 404", async () => {
  await withServer(async ({ app }) => {
    const res = await app.inject({
      method: "GET",
      url: "/incidents/00000000-0000-0000-0000-000000000000",
      headers: auth,
    });
    assert.equal(res.statusCode, 404);
    assert.equal(res.json().error, "incident_not_found");
  });
});

test("malformed JSON is a 400, not a crash", async () => {
  await withServer(async ({ app }) => {
    const res = await app.inject({
      method: "POST",
      url: "/intake/web",
      headers: { "content-type": "application/json" },
      payload: "{not json",
    });
    assert.equal(res.statusCode, 400);
  });
});

/* ------------------------------------------------------------------ *
 * Location and dispatch
 * ------------------------------------------------------------------ */

test("the location gate blocks dispatch at the HTTP boundary", async () => {
  await withServer(async (ctx) => {
    const id = await seedIncident(ctx);
    const before = await ctx.h.repo.requireById(id);

    const res = await ctx.app.inject({
      method: "POST",
      url: `/incidents/${id}/dispatch`,
      headers: auth,
      payload: { version: before.version, unit_id: "AMB-01" },
    });

    // Enforced here rather than trusted from the client: a console bug must
    // not be able to dispatch against a location nobody confirmed.
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error, "location_not_confirmed");
  });
});

test("selecting a candidate confirms the location and records the operator", async () => {
  await withServer(async (ctx) => {
    const id = await seedIncident(ctx);
    let incident = await ctx.h.repo.requireById(id);

    // Two candidates the system would not choose between on its own.
    await ctx.h.repo.setLocation(id, incident.version, {
      location: {
        candidates: [
          {
            source: "stated_landmark",
            point: { latitude: 17.3616, longitude: 78.4747 },
            accuracy_m: 400,
            label: "Shiv Mandir, Charminar",
            trust: 30,
            obtained_at: "2026-08-31T09:00:00.000Z",
          },
          {
            source: "stated_landmark",
            point: { latitude: 17.4399, longitude: 78.4983 },
            accuracy_m: 400,
            label: "Shiv Mandir, Secunderabad",
            trust: 30,
            obtained_at: "2026-08-31T09:00:00.000Z",
          },
        ],
        selected_index: null,
        selected_by_human: false,
        stated: null,
      },
      ambiguity: "Two landmarks match. Confirm with the caller.",
      actor: { id: null },
    });

    incident = await ctx.h.repo.requireById(id);
    assert.equal(incident.location_ambiguity !== null, true);

    const res = await ctx.app.inject({
      method: "POST",
      url: `/incidents/${id}/location/select`,
      headers: auth,
      payload: { version: incident.version, candidate_index: 1 },
    });

    assert.equal(res.statusCode, 200);

    const after = await ctx.h.repo.requireById(id);
    assert.equal((after.location as { selected_index: number }).selected_index, 1);
    assert.equal((after.location as { selected_by_human: boolean }).selected_by_human, true);
    // The question is settled once a person has answered it.
    assert.equal(after.location_ambiguity, null);
    // The generated geography column follows the selection.
    assert.ok(Math.abs(after.location_lat! - 17.4399) < 1e-6);

    const trail = await ctx.h.repo.auditTrail(id);
    const selection = trail.filter((e) => e.type === "location_selected").at(-1)!;
    assert.equal(selection.actor, "op-1");
  });
});

test("a stale candidate index is a 409, not a silent miss", async () => {
  await withServer(async (ctx) => {
    const id = await seedIncident(ctx);
    const incident = await ctx.h.repo.requireById(id);

    const res = await ctx.app.inject({
      method: "POST",
      url: `/incidents/${id}/location/select`,
      headers: auth,
      payload: { version: incident.version, candidate_index: 7 },
    });

    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error, "stale_location_candidates");
  });
});

test("the units endpoint answers with a reason rather than an empty list", async () => {
  await withServer(async (ctx) => {
    const id = await seedIncident(ctx);

    const res = await ctx.app.inject({
      method: "GET",
      url: `/incidents/${id}/units`,
      headers: auth,
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().units, []);
    // "We do not know where this is" and "no ambulance is free" are different
    // answers and need different next actions from the call-taker.
    assert.ok(res.json().blocked_reason);
  });
});

test("the queue reports whether each incident can be dispatched at all", async () => {
  await withServer(async (ctx) => {
    await seedIncident(ctx);

    const res = await ctx.app.inject({ method: "GET", url: "/incidents", headers: auth });
    const [row] = res.json().incidents;

    assert.equal(row.location_confirmed, false);
    assert.ok("location_ambiguity" in row);
  });
});

/* ------------------------------------------------------------------ *
 * Account-backed authentication
 * ------------------------------------------------------------------ */

test("sign-in issues a session that the operator routes accept", async () => {
  await withServer(async (ctx) => {
    const accounts = new OperatorService(ctx.h.db);
    await accounts.create({
      operatorId: "op-live",
      displayName: "Live Operator",
      role: "call_taker",
      password: "a good long passphrase",
      mustChangePassword: false,
    });

    const app = buildServerWithAccounts(ctx, accounts);

    const signIn = await app.inject({
      method: "POST",
      url: "/auth/sign-in",
      payload: { operator_id: "op-live", password: "a good long passphrase" },
    });

    assert.equal(signIn.statusCode, 200);
    const token = signIn.json().token as string;

    const queue = await app.inject({
      method: "GET",
      url: "/incidents",
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(queue.statusCode, 200);

    await app.close();
  });
});

test("a wrong password is a 401 that says nothing useful", async () => {
  await withServer(async (ctx) => {
    const accounts = new OperatorService(ctx.h.db);
    await accounts.create({
      operatorId: "op-live",
      displayName: "Live Operator",
      role: "call_taker",
      password: "a good long passphrase",
      mustChangePassword: false,
    });

    const app = buildServerWithAccounts(ctx, accounts);

    const wrong = await app.inject({
      method: "POST",
      url: "/auth/sign-in",
      payload: { operator_id: "op-live", password: "guess" },
    });
    const unknown = await app.inject({
      method: "POST",
      url: "/auth/sign-in",
      payload: { operator_id: "nobody", password: "guess" },
    });

    assert.equal(wrong.statusCode, 401);
    assert.equal(unknown.statusCode, 401);
    // Identical responses. Which half was wrong is in auth_events only.
    assert.deepEqual(wrong.json(), unknown.json());

    await app.close();
  });
});

test("signing out immediately invalidates the session", async () => {
  await withServer(async (ctx) => {
    const accounts = new OperatorService(ctx.h.db);
    await accounts.create({
      operatorId: "op-live",
      displayName: "Live Operator",
      role: "call_taker",
      password: "a good long passphrase",
      mustChangePassword: false,
    });

    const app = buildServerWithAccounts(ctx, accounts);

    const { token } = (
      await app.inject({
        method: "POST",
        url: "/auth/sign-in",
        payload: { operator_id: "op-live", password: "a good long passphrase" },
      })
    ).json() as { token: string };

    const auth = { authorization: `Bearer ${token}` };

    await app.inject({ method: "POST", url: "/auth/sign-out", headers: auth });

    const after = await app.inject({ method: "GET", url: "/incidents", headers: auth });
    // The property the interim tokens could not provide.
    assert.equal(after.statusCode, 401);

    await app.close();
  });
});

test("the interim environment token still works alongside accounts", async () => {
  await withServer(async (ctx) => {
    const app = buildServerWithAccounts(ctx, new OperatorService(ctx.h.db));

    // A deployment mid-migration keeps working while accounts are created.
    const res = await app.inject({ method: "GET", url: "/incidents", headers: auth });
    assert.equal(res.statusCode, 200);

    await app.close();
  });
});
