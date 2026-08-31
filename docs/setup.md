# Infrastructure setup

Decided: **Supabase (Mumbai)** as the database, and the legacy Firebase project
exported then decommissioned.

## You do not need a database to develop

The test suite runs on [PGlite](https://pglite.dev) — real Postgres compiled to
WebAssembly, running in-process. No server, no container, no credentials.

```bash
npm test
```

45 tests, zero infrastructure. Triggers, generated columns, RLS, constraints and
transaction semantics all behave as they will in production, so this is genuine
coverage rather than a mock. A real database is only needed to *run* the API and
console, not to build or verify them.

## Supabase

### 1. Create the project

- Region: **South Asia (Mumbai)** — `ap-south-1`. This keeps emergency call data
  in India, which matters under the DPDP Act and in any pitch to an Indian
  agency. Do not accept the default region.
- Save the database password Supabase generates; it is shown once.

### 2. Enable PostGIS

In the SQL editor:

```sql
CREATE EXTENSION IF NOT EXISTS postgis;
```

Without it, migration `002` is skipped and proximity search stays unavailable.
Everything else works, so this is not urgent until M3 — but it is one line now
versus a puzzle later.

### 3. Connection string

Project settings → Database → Connection string → **Session pooler**.

> **Prefer port 5432 (session pooler) over 6543 (transaction pooler).**
>
> Transaction-mode pooling pins a backend connection for the duration of a
> transaction, so the `SELECT … FOR UPDATE` the repository relies on does hold
> — the write path is not broken by it. What transaction mode does not preserve
> is session state *between* transactions: `SET`, advisory locks held across
> transactions, `LISTEN`/`NOTIFY`, and server-side prepared statements.
>
> None of those are used today, so 6543 would work for the current repository.
> Session mode is the default here because M4 wants `LISTEN`/`NOTIFY` for
> console updates and M7 may want advisory locks, and discovering the
> constraint then is worse than choosing correctly now.

Copy `apps/api/.env.example` to `apps/api/.env` and set `DATABASE_URL`, leaving
the password placeholder in place. Then:

```bash
npm run db:password
```

This prompts with echo disabled, percent-encodes the password and writes it into
`.env`. Nothing is echoed, and it never reaches your shell history or a chat
transcript.

The encoding is not cosmetic. Supabase generates passwords containing `@ : / ?
# &`, all of which are structural in a connection URI. An unencoded `@`
truncates the host and produces `getaddrinfo ENOTFOUND` rather than an auth
error — a genuinely misleading failure to debug.

### 4. Migrate and verify

```bash
npm run migrate && npm run db:check
```

`db:check` reports server version, PostGIS presence and migration state. The
quiet failure modes here are "reachable but no PostGIS" and "one migration
behind" — both look healthy until something specific breaks much later.

### The rule that keeps this from repeating the prototype's mistake

Supabase is adopted as **managed Postgres**, not as a Firebase replacement.

Its client SDK can write directly to tables through PostgREST. That is precisely
the shape that made the prototype indefensible: the browser wrote incident state
straight to Firestore, with no rules anywhere in the repository.

- **The API owns every write.** The console never writes to the database.
- The console holds no database credentials at all. Live updates arrive over
  SSE from the API, not from Supabase Realtime.
- Migration `003_rls.sql` enables Row Level Security everywhere with zero
  policies, denying `anon` and `authenticated` outright.
- Migration `011` adds a least-privilege `resqai_api` role with policies scoped
  to it; `012` revokes Supabase's default grants to the client roles.

`db/security.test.ts` asserts the whole posture, so it cannot drift silently.

### The M4 policy that was planned and should not be added

003 said the console would get a scoped `SELECT` policy for reading incidents
directly. **M4 did not build that, and adding it now would be a regression.**
The console talks only to the API — no Supabase client, no credentials.

That policy has no consumer. It would create a direct-database read path that
does not exist, need Supabase Auth JWTs this system does not issue (operator
sessions are our own, so `auth.uid()` is always null), and relax a deny-all
posture in exchange for nothing. The plan predated the console; the console
turned out better than the plan.

### What was hardened instead

The API connects as the table **owner**, and owners bypass RLS — so every
protection in 003 was invisible to the one component that touches the data. A
bug or an injection had unrestricted access, including DELETE.

`resqai_api` gets only what the API needs:

| Tables | Grants |
|---|---|
| incidents, transcripts, units, operators… | SELECT, INSERT, UPDATE |
| audit_events, auth_events | SELECT, INSERT |
| operator_sessions | + DELETE, for the expiry sweep only |
| schema_migrations | SELECT |

**No DELETE on anything holding incident data.** An incident is closed by
status and emptied by the retention purge, which nulls content rather than
removing rows — so the grant does not exist. That makes it a fact the database
enforces rather than a property of our code being correct, and it is the same
reasoning as the append-only trigger: the trigger refuses the operation, and
the withheld grant means it never reaches the trigger.

The role is created `NOLOGIN`, so applying the migration changes nothing until
`DATABASE_URL` points at it and cannot take a running deployment down:

```sql
ALTER ROLE resqai_api WITH LOGIN PASSWORD '…';
```

### An audit finding worth recording

After 011, `anon` and `authenticated` still held **210 table grants** —
Supabase's default, on the assumption that RLS does the gatekeeping. Nothing
was exposed, because RLS was on with no policy naming them. But the entire
protection rested on one property of one table staying true: a table created
without `ENABLE ROW LEVEL SECURITY` would have turned 210 dormant grants into
live access to emergency call data, and nothing would have reported it.

012 revokes them, and the default privileges that would re-grant on the next
table added. The count went 210 → 42; all 42 remaining are PostGIS's own
`spatial_ref_sys`, `geometry_columns` and `geography_columns`, granted by
`supabase_admin`, which this project's role cannot revoke. Those hold EPSG
reference data and schema metadata, not incident data. **Every table holding
emergency data is at zero.**

## Local Postgres (optional)

Useful for offline work. PostgreSQL 18 is already installed and running as
`postgresql-x64-18`, configured for `scram-sha-256`, so it needs the superuser
password set during installation.

```bash
psql -U postgres -h localhost -v pw="$(openssl rand -hex 16)" -f scripts/setup-db.sql
```

Creates the `resqai` role, database and extensions. Idempotent. Then point
`DATABASE_URL` at it and run the same `npm run migrate`.

If the superuser password is lost, it is recoverable by temporarily setting
`trust` in `C:\Program Files\PostgreSQL\18\data\pg_hba.conf`, restarting the
service, running `ALTER USER postgres PASSWORD '…'`, then restoring
`scram-sha-256`. Do this by hand rather than scripting it — it opens the
database to anyone on the machine while it is in effect.

## Firebase decommissioning

Nothing in the new architecture uses Firebase. Postgres replaces Firestore and a
realtime read channel replaces `onSnapshot`.

**Export first.** The transcripts in `call_transcripts` are real Indian
emergency-call phrasing — genuinely useful as M2 seed data and as a starting
point for the M6 evaluation set. That is the one thing in the project worth
keeping.

```bash
npm install firebase-admin --no-save
export FIREBASE_ADMIN_CREDENTIALS="$(cat service-account.json)"
node scripts/export-firebase.mjs
```

Writes `data/legacy/call_transcripts.json` and `data/legacy/emergencies.json`,
converting Firestore Timestamps to ISO strings so they survive as plain JSON.
The script only reads; deletion stays a deliberate manual step.

Then, from the Firebase console: review the export, and delete project
`resqai-4700b`.

Why delete rather than keep it idle: the web API key and project ID are in git
history across all three commits. Firebase web keys are public identifiers by
design, so this is not a credential leak — but security rests entirely on
Firestore rules, and there are none in the repository. An unused project with
unknown rules is attack surface for no benefit.


## Extraction model selection

Measured on 2026-08-31 against OpenCode Go, extracting the full 11-field
`IncidentExtraction` from a two-segment Hinglish transcript. Run
`npm run extraction:probe` to reproduce against any endpoint.

| Model | Latency | Tool calling | Degraded fields | Notes |
|---|---|---|---|---|
| `deepseek-v4-flash` | 12-20s | yes | 0 | **Default.** Best latency at equal quality |
| `mimo-v2.5` | 20s | yes | 0 | Solid second choice |
| `qwen3.8-max` | 25s | yes | 0 | Under-prioritised P1 where others said P0 |
| `minimax-m3` | 27s | fell back to JSON mode | 0 | Best landmark handling verbatim |
| `mimo-v2.5-pro` | 35s | yes | 0 | Slowest of the working set |
| `glm-5.3`, `kimi-k3`, `glm-5.3-flash`, `qwen3.8-flash` | >60s | — | — | Timed out on this schema |
| `grok-4.6` | — | — | — | Rejects the OpenAI-compatible format |

### The latency problem

**12-20 seconds per extraction pass is workable for text intake and far too
slow for live voice.** The reference result in this field (Corti, Copenhagen)
turned on a ~44s total time-to-recognition for an entire call; spending 15s of
that on one extraction pass leaves nothing for recognition, dialogue or
dispatch.

This is a known constraint going into M5, not a surprise to discover there.
The options when voice lands, roughly in order of preference:

  1. A faster endpoint. Claude Haiku or a hosted small model answers this
     schema in 1-3s. The `ExtractionProvider` interface makes it a config change.
  2. Extract incrementally rather than re-running the whole transcript each
     pass, so later passes are cheaper than the first.
  3. Split the schema — classify type and priority on a small fast grammar,
     fill the remaining fields on a slower second pass.

None of these are blocked by the current architecture. All three are cheaper
to do once there is an evaluation harness (M6) to say whether the faster
option actually costs accuracy.

### A note on prompt version 1.1.0

Every model tested breached the same three consistency rules until they were
stated explicitly: `status`/`value` disagreement, `children_involved: true`
without the children lane routed, and `P0_immediate` without
`life_threat_indicated`. Adding a CONSISTENCY section to the prompt took all
of them to zero recorded problems.

The semantic validator caught every one of these before they reached an
operator, which is the layer working as intended — but a rule the validator
has to catch on every pass belongs in the prompt.

## Voice latency (M5)

The two-tier design in `VoiceSession` exists because of the M3 finding above.
Measured 2026-08-31 against OpenCode Go / `deepseek-v4-flash`:

| Pass | Grammar | Latency |
|---|---|---|
| Fast triage | 4 flat fields | **3-4 s mean**, 2.3-6.7 s observed |
| Full extraction | 11 fields, nested | 12-20 s |

The fast pass runs while the caller is still speaking and produces the lane,
the priority and the life-threat flag. The full pass runs behind it on a 15 s
interval and always once more when the call ends.

### What the numbers actually say

The tail matters more than the mean. A single live call recorded 10 s to first
classification against a 3-4 s benchmark, and `max_tokens` was ruled out as the
cause — 256, 2000 and 8000 all average the same. It is endpoint variance on a
shared free-tier gateway.

That is a deployment finding, not an architecture one: the tiering works, and
the remaining variance is a property of the endpoint. A paid tier or a
self-hosted small model would tighten it, and M6 should measure the
distribution rather than the mean, because a 95th-percentile time-to-triage is
the number an operating agency would actually hold this to.

For reference, the published result this is measured against (Corti,
Copenhagen) turned on roughly 44 s total time-to-recognition for a whole call.
A 3-4 s classification inside that budget is workable; a 20 s one is not, which
is the entire reason the fast tier exists.

## Evaluation (M6)

`npm run eval -- --model deepseek-v4-flash` scores every model against
`apps/api/eval/cases.json` and writes a timestamped result under
`apps/api/eval/results/`. The rule-based provider is always included as a
floor: a model that cannot beat keyword matching is not earning its cost.

### First real run, 2026-08-31, 20 cases

| | deepseek-v4-flash | rule-based |
|---|---|---|
| **Missed life threats** | **0** | 10 |
| False life threats | 0 | 0 |
| Under-triaged | 1 | 7 |
| Over-triaged | 0 | 2 |
| Weighted priority error | 9 | 44 |
| Escalation recall | 100% | 30% |
| Type accuracy | 85% | 65% |
| Priority exact | 95% | 55% |
| Agency recall | 85% | 45% |
| Verbatim preservation | 83% | 0% |
| Degraded fields / case | 0.00 | 0.00 |
| Invented citations | 0 | 0 |
| Latency p50 / p95 | 21.3 s / **59.7 s** | 1 ms / 1 ms |

### What this actually says

**The safety numbers are good.** Zero missed life threats and 100% escalation
recall across a set built specifically to include under-triage traps, negation
and cases whose correct answer is "unclear".

**The latency is disqualifying, and only the distribution shows it.** A p50 of
21 s and a p95 of 60 s — against 12-20 s measured on single calls in M3. Twenty
cases back to back on a shared free-tier gateway is enough to trigger
queueing, and a mean would have reported roughly 25 s and hidden the minute-long
tail entirely. This is the reason M5 left a note saying to measure the
distribution rather than the mean.

It is a deployment finding, not an architecture one. The tiering in M5 stands;
the endpoint is the constraint.

### Where it fails, which is the actionable part

  negation      1/1    "there is no fire" still classified as a fire
  referral      1/1    non-emergency routed as an emergency
  uncertainty   1/1    a hedged third-hand report answered confidently
  over-triage   1/2

The pattern is one thing: **it does not take "no" for an answer.** Negation, a
non-emergency, and a caller saying "I'm not sure" all get classified as real
incidents. That errs in the safe direction, and it costs a response unit that
something else needed — which at scale is its own harm.

Addressable in the prompt, and the harness is what will say whether an
attempted fix worked.

### The negation fix, measured

Prompt 1.1.0 -> 1.2.0, same set, same model, 2026-08-31:

| | before | after |
|---|---|---|
| Type accuracy | 85% | **95%** |
| Agency recall | 85% | **90%** |
| Weighted priority error | 9 | **3** |
| Missed life threats | 0 | **0** |
| Escalation recall | 100% | **100%** |

The three failing cases -- negation, referral, uncertainty -- all pass. Nothing
regressed on the safety numbers, which is the condition the change had to meet.

The fix was not a negation detector. The prompt opened with "you extract
 structured incident data from emergency contact transcripts", which presupposes
an emergency in every input, and paired it with an unscoped "failing to escalate
costs a great deal". Together those told the model to assume an incident exists
and then be cautious about it.

1.2.0 separates the two judgements. A new section asks whether this is an
emergency at all -- naming negation, resolved events, hypotheticals, enquiries
and hedged reports as things that are not incident reports -- and the escalation
caution is now explicitly scoped to *how serious* an emergency is rather than
*whether* one is happening.

### One label was wrong, and that matters

The run also flagged a false life threat on the Plus Code case. On inspection
the model was right and the label was not: an injured motorcyclist in a
collision is defensibly a life threat, and that case existed to test Plus Code
preservation, so the judgement had been set carelessly.

Rather than flip the label, the case is marked `life_threat_ambiguous` — the
same principle as `acceptable_types`, applied to the judgement that carries the
most weight. The distinction matters: editing a set whenever it delivers
unwelcome news stops it being an evaluation, so the flag is opt-in, defaults
off, and is documented in the schema as the easiest place in the whole harness
to cheat without noticing.

### The run is a gate, not a report

A missed life threat exits non-zero. Wired into CI, a prompt change that starts
missing them cannot merge quietly — which is the whole point of having measured
any of this.

## Operator accounts (M7)

Replaces the interim `OPERATOR_TOKENS` environment variable. That mechanism was
not weak so much as **permanent**: a token could not be withdrawn without
redeploying the service, never expired, and gave every operator identical
capability.

```bash
npm run operators                                    # list
npm run operators -- --add op-priya --role supervisor
npm run operators -- --disable op-priya --reason "left the service"
npm run operators -- --revoke op-priya --reason "device lost"
npm run operators -- --auth-log
```

Passwords are prompted for with echo disabled and never accepted as an
argument, because a password on a command line is in the shell history and the
process list.

### Decisions worth knowing

**Server-side sessions, not JWTs.** A JWT cannot be revoked before it expires
without a blocklist, which reintroduces the database lookup that was the reason
to reach for a JWT. Where access may need withdrawing mid-shift, revocation is
worth more than saving a query per request.

**Tokens stored hashed.** SHA-256, not scrypt — these are 256-bit random values
with no entropy problem, so a slow KDF would add latency to every request and
defend against nothing. A read of `operator_sessions` yields nothing usable.

**Passwords with scrypt**, N=2^15, random salt per credential, parameters
stored alongside the hash so the cost can be raised later without invalidating
anything.

**Every sign-in failure returns the same response.** Distinguishing "no such
operator" from "wrong password" tells an attacker which half of a guess was
right. The real reason goes to `auth_events`, which is append-only for the same
reason the incident audit log is: an attacker who can delete their own failed
attempts leaves no trace of having tried. An unknown operator also triggers a
dummy hash verification, so timing does not leak what the response does not.

**Disabled accounts are never deleted.** An operator ID appears throughout the
append-only audit trail; removing the row would make every past override
unattributable — destroying the accountability record to tidy a user list.

**Three roles, each including those below it:** `call_taker` reviews and
dispatches, `supervisor` adds legal hold and status changes, `admin` adds
account management. An environment token, if still present, is treated as
`call_taker` — it cannot be revoked, so it should not be able to release a
legal hold.

### Migration path

Both mechanisms work at once. Accounts are checked first; `OPERATOR_TOKENS`
remains as a fallback so a running deployment keeps working while accounts are
created. The service warns on every boot while the env var is set, and the
`operators` listing says the same. Remove it once every operator has an account.
