-- 011_least_privilege
--
-- A constrained role for the API to run as, and RLS policies scoped to it.
--
-- ## Why the policy planned in 003 is not the policy being added
--
-- Migration 003 said the console would get a scoped SELECT policy in M4, for
-- reading incidents directly through PostgREST. M4 did not build that. The
-- console talks only to the API: no Supabase client, no database credentials,
-- and live updates arrive over SSE from the API rather than from Supabase
-- Realtime.
--
-- So that policy has no consumer. Adding it now would create a direct-database
-- read path that does not exist, require Supabase Auth JWTs this system does
-- not issue — operator sessions are our own, so `auth.uid()` is always null —
-- and relax a deny-all posture in exchange for nothing. The plan was written
-- before the console was built, and the console turned out better than the
-- plan. `anon` and `authenticated` keep exactly no access.
--
-- ## What actually needed hardening
--
-- The API connects as the table owner, and **owners bypass RLS**. Every
-- protection in 003 is therefore invisible to the one component that touches
-- the data. A bug or an injection in the API has unrestricted access,
-- including DELETE on the append-only tables — the trigger would stop it, but
-- only because someone remembered to write the trigger.
--
-- This adds a role with only the grants the API actually needs. It makes
-- "the API cannot delete an incident" a fact the database enforces rather than
-- a property of our code being correct.

-- ---------------------------------------------------------------------------
-- The role
-- ---------------------------------------------------------------------------
--
-- Created without LOGIN. A password belongs in a deployment, not in a
-- migration that lives in git — grant LOGIN and set one out of band:
--
--   ALTER ROLE resqai_api WITH LOGIN PASSWORD '…';
--
-- Until DATABASE_URL points at it, nothing changes: the API keeps connecting
-- as the owner and this role sits unused. That is deliberate, so applying this
-- migration cannot take a running deployment down.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'resqai_api') THEN
        CREATE ROLE resqai_api NOLOGIN;
    END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO resqai_api;

-- ---------------------------------------------------------------------------
-- Grants, by what the table is for
-- ---------------------------------------------------------------------------

-- Operational state: read, create, amend. Never delete.
--
-- An incident is closed by setting its status and emptied by the retention
-- purge, which nulls content rather than removing rows. There is no legitimate
-- path that deletes one, so the grant does not exist.
GRANT SELECT, INSERT, UPDATE ON incidents           TO resqai_api;
GRANT SELECT, INSERT, UPDATE ON transcript_segments TO resqai_api;
GRANT SELECT, INSERT, UPDATE ON extraction_passes   TO resqai_api;
GRANT SELECT, INSERT, UPDATE ON intake_messages     TO resqai_api;
GRANT SELECT, INSERT, UPDATE ON response_units      TO resqai_api;
GRANT SELECT, INSERT, UPDATE ON unit_recommendations TO resqai_api;
GRANT SELECT, INSERT, UPDATE ON voice_calls         TO resqai_api;
GRANT SELECT, INSERT, UPDATE ON operators           TO resqai_api;

-- Append-only logs: read and write, nothing else.
--
-- The triggers already refuse UPDATE and DELETE. Withholding the grant as well
-- means an attempt fails at the permission check, before any trigger has to
-- catch it — two independent mechanisms rather than one.
GRANT SELECT, INSERT ON audit_events TO resqai_api;
GRANT SELECT, INSERT ON auth_events  TO resqai_api;

-- Sessions are the one thing the API genuinely deletes: expired rows are swept
-- so the table does not grow without bound. The audit of who signed in and
-- when lives in `auth_events`, which cannot be deleted, so sweeping sessions
-- destroys no history.
GRANT SELECT, INSERT, UPDATE, DELETE ON operator_sessions TO resqai_api;

-- Migration bookkeeping is read-only at runtime. The migration runner connects
-- as the owner.
GRANT SELECT ON schema_migrations TO resqai_api;

-- ---------------------------------------------------------------------------
-- Policies
-- ---------------------------------------------------------------------------
--
-- RLS is on with no policies, which denies everything to non-owners — and
-- `resqai_api` is a non-owner. Without policies the grants above would have no
-- effect at all.
--
-- These are deliberately unscoped: `USING (true)`. Row-level filtering would
-- be theatre here, because the API legitimately reads every incident in the
-- system and there is no per-row distinction to enforce. The real constraint
-- is the grant list above — which verbs exist at all — not which rows.
--
-- `anon` and `authenticated` are named nowhere, so they keep exactly no access.

CREATE POLICY api_all ON incidents            FOR ALL TO resqai_api USING (true) WITH CHECK (true);
CREATE POLICY api_all ON transcript_segments  FOR ALL TO resqai_api USING (true) WITH CHECK (true);
CREATE POLICY api_all ON extraction_passes    FOR ALL TO resqai_api USING (true) WITH CHECK (true);
CREATE POLICY api_all ON intake_messages      FOR ALL TO resqai_api USING (true) WITH CHECK (true);
CREATE POLICY api_all ON response_units       FOR ALL TO resqai_api USING (true) WITH CHECK (true);
CREATE POLICY api_all ON unit_recommendations FOR ALL TO resqai_api USING (true) WITH CHECK (true);
CREATE POLICY api_all ON voice_calls          FOR ALL TO resqai_api USING (true) WITH CHECK (true);
CREATE POLICY api_all ON operators            FOR ALL TO resqai_api USING (true) WITH CHECK (true);
CREATE POLICY api_all ON operator_sessions    FOR ALL TO resqai_api USING (true) WITH CHECK (true);
CREATE POLICY api_read ON schema_migrations   FOR SELECT TO resqai_api USING (true);

-- The append-only logs get read and insert policies only. A future policy
-- cannot widen this past the grants, but stating it here means the intent is
-- visible in the schema rather than inferred from an absent GRANT.
CREATE POLICY api_read   ON audit_events FOR SELECT TO resqai_api USING (true);
CREATE POLICY api_append ON audit_events FOR INSERT TO resqai_api WITH CHECK (true);
CREATE POLICY api_read   ON auth_events  FOR SELECT TO resqai_api USING (true);
CREATE POLICY api_append ON auth_events  FOR INSERT TO resqai_api WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- Future tables
-- ---------------------------------------------------------------------------
--
-- A table added later gets no grant by default, which fails closed: the API
-- loses access until someone grants it deliberately. That is the right
-- direction to fail, and it is why there is no blanket
-- `GRANT ... ON ALL TABLES` here — a wildcard would silently hand the API
-- DELETE on whatever gets added next.
