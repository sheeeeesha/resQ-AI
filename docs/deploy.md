# Deployment

**The console deploys to Vercel. The API does not.**

That split is not a preference. Four things in the API outlive a single
request, and Vercel's functions are stateless and time-bounded:

| What | Where | Why serverless breaks it |
|---|---|---|
| `IncidentNotifier` | `src/realtime/notifier.ts` | Holds one Postgres `LISTEN` connection for the process lifetime. A function that exits takes the registration with it, and live updates stop silently. |
| SSE stream | `src/http/server.ts` | Stays open for a shift with a 25s heartbeat. Vercel caps a function at 10s (Hobby) / 60s (Pro) / 300s (Enterprise). |
| `VoiceSession` | `src/voice/session.ts` | Holds transcript and scheduler state in memory across a live call. There is no request to attach that to. |
| `RateLimiter` | `src/http/auth.ts` | An in-memory counter. Every concurrent instance gets its own, so a limit of 10 becomes 10 × instances. |

There is also the ordinary serverless-plus-Postgres problem: each concurrent
invocation opens its own connection, and Supabase's session pooler has a finite
number to give.

Removing all four is possible — poll instead of `LISTEN`, drop SSE, move rate
limiting to Redis — but voice cannot be made stateless without redesigning it,
and doing the rest would gut the M4 realtime design to fit a host that was the
wrong shape for this service.

## Console → Vercel

The console is a static Next.js app that holds no database credentials and
talks only to the API. It is genuinely well suited to Vercel.

### Project settings

| Setting | Value |
|---|---|
| Framework | Next.js |
| Root directory | `apps/console` |
| Build command | `npm run build` |
| Install command | `npm install` |
| Node version | 22.x |

The repository is an npm workspace, so **leave "Include files outside the root
directory" enabled**. The console imports `@resqai/schema` from
`packages/schema`, and excluding the parent breaks the build with a module
resolution error that does not name the cause.

### Environment variables

One, and it is public by design:

| Variable | Example | Notes |
|---|---|---|
| `NEXT_PUBLIC_API_URL` | `https://api.resqai.example.in` | The API's public origin. `NEXT_PUBLIC_` means it is compiled into the browser bundle — never put a secret behind that prefix. |

That is the whole list. No database URL, no model key, no operator token. The
console holds nothing worth stealing, which is the property that makes it safe
to put on a CDN.

### After deploying

Add the Vercel origin to the API's `CONSOLE_ORIGINS`, or every request will be
refused by CORS:

```
CONSOLE_ORIGINS=https://resqai-console.vercel.app,http://localhost:3000
```

Vercel gives preview deployments their own URLs. Either add them explicitly or
accept that previews cannot reach a production API — which is usually the right
answer anyway, since a preview build reaching live emergency data is not
something to enable by default.

## API → a host that runs a process

Anything that runs a container or a long-lived Node process. Railway, Render,
Fly.io, or a VM. The requirements are modest:

- One always-on instance (scale horizontally only after moving rate limiting
  out of memory)
- Outbound access to Supabase, the model endpoint, and OSM
- A health check on `GET /health`, and readiness on `GET /ready`

`GET /ready` reports database reachability, which channels are usable, whether
live updates are connected, and how many operator accounts exist. Point the
platform's health check at `/health` and read `/ready` yourself after a deploy.

### Environment variables

**Required in production.** The service refuses to start without these:

| Variable | Notes |
|---|---|
| `DATABASE_URL` | Supabase **session pooler**, port 5432. Not 6543 — transaction pooling does not preserve the `LISTEN` registration. |
| `CALLER_NUMBER_SALT` | `npm run db:salt`. Without it a phone-number hash is a lookup table. |
| `OPERATOR_TOKENS` | Only until operator accounts exist. See below. |
| `NODE_ENV=production` | |

**Channels.** A channel with no signing secret is refused rather than served
unverified, so omitting these disables that channel rather than opening it:

| Variable | Notes |
|---|---|
| `WHATSAPP_APP_SECRET` | Meta app secret, verifies `X-Hub-Signature-256`. |
| `WHATSAPP_VERIFY_TOKEN` | Echoed during Meta's registration handshake. |
| `TWILIO_AUTH_TOKEN` | Verifies `X-Twilio-Signature`. |
| `PUBLIC_URL` | The API's own public origin. Twilio signs against the URL it called, and behind a TLS-terminating proxy the URL Node observes is `http://` while Twilio signed `https://` — so this is configured, never reconstructed. |

**Extraction:**

| Variable | Default | Notes |
|---|---|---|
| `EXTRACTION_BASE_URL` | — | `https://opencode.ai/zen/go/v1` for OpenCode Go. |
| `EXTRACTION_API_KEY` | — | Omit and the service runs on keyword matching, escalating everything. |
| `EXTRACTION_MODEL` | `claude-opus-5` | `deepseek-v4-flash` on OpenCode Go. |
| `EXTRACTION_PROVIDER` | `auto` | |

**Optional, each degrading rather than failing:**

| Variable | Absent behaviour |
|---|---|
| `OSRM_BASE_URL` | Travel times become straight-line estimates, flagged on every unit. |
| `NOMINATIM_USER_AGENT` | Landmarks stop resolving. Coordinates, Plus Codes and map links still work — they need no network. |
| `SESSION_HOURS` (12) | |
| `RETENTION_DAYS` (90) | |
| `CONSOLE_ORIGINS` | Defaults to localhost, so the deployed console cannot reach it. |
| `REFERENCE_PREFIX` (IN) | Two letters, shown in operator-facing references. |

### Deploy sequence

```bash
npm run migrate        # apply pending migrations
npm run db:check       # server version, PostGIS, migration state
npm run operators      # create accounts, then drop OPERATOR_TOKENS
```

`migrate` is idempotent and safe to run on every deploy. It is deliberately not
run automatically at boot: a migration that fails half way through a rolling
deploy is worse than one that fails in a step you are watching.

## Scheduled work

Two jobs that nothing runs on its own yet.

**Retention.** Reports by default, destroys only with `--sweep`:

```bash
npm run retention                              # report
npm run retention -- --sweep --actor cron-job  # destroy
```

Daily is reasonable. Read the report before scheduling the sweep — the first
run of this on real data found six incidents with no retention date at all,
which every other figure was reporting as compliant.

**Expired sessions** accumulate until swept. Not urgent; the rows are small and
already unusable.

Vercel Cron cannot run either — they need the API's database access, and the
API is not on Vercel. Use the host's own scheduler.

## What to check after a deploy

```bash
curl https://api.example.in/ready
```

Look at `channels`, `live_updates`, and `operator_accounts`. The service also
warns on boot about every capability that is absent — no model provider, no
geocoder, no routing engine, PostGIS missing, `OPERATOR_TOKENS` still set —
because each of those is a silent failure waiting for the request that needed
it.

## Not production-ready yet

Stated plainly, because a deployment guide that omits this would be misleading:

- **Latency.** The evaluation harness measured p95 at ~60s on the shared
  OpenCode free tier. That is disqualifying for a live path. A paid tier or a
  self-hosted small model is the fix; measure it with `npm run eval` rather
  than assuming.
- **Rate limiting is per-instance.** Run one instance until it moves to Redis.
- **No telephony webhook.** The voice session is driven directly; wiring Exotel
  or Twilio media streams to it is the remaining piece.
- **The ASR adapter is unverified.** Written against Sarvam's documented API,
  never run against it.
