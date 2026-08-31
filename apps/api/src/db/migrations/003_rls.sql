-- 003_rls
--
-- Row Level Security, default deny.
--
-- The prototype let the browser write incident state straight to the datastore
-- with no rules anywhere in the repository. Supabase makes that same shape
-- available through PostgREST, so the guard belongs in the schema rather than
-- in a convention someone has to remember.
--
-- How this behaves:
--
--   * The API connects as the table owner, and owners bypass RLS unless
--     FORCE ROW LEVEL SECURITY is set. So the API is unaffected.
--   * Supabase's `anon` and `authenticated` roles are not owners. With RLS on
--     and no policies granting them anything, every direct client read and
--     write is denied.
--
-- The console gets its realtime *read* access in M4, as an explicit SELECT
-- policy scoped to an authenticated operator. Writes stay with the API
-- permanently — there is no policy to add later that would change that.

ALTER TABLE incidents            ENABLE ROW LEVEL SECURITY;
ALTER TABLE transcript_segments  ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events         ENABLE ROW LEVEL SECURITY;
ALTER TABLE schema_migrations    ENABLE ROW LEVEL SECURITY;

-- No policies are created deliberately. In Postgres, RLS enabled with zero
-- policies denies everything to non-owners, which is the posture we want until
-- a specific, reviewed grant is added.

-- Belt and braces for the audit log: even a future policy must not be able to
-- hand out write access to it. Append-only is already enforced by trigger; this
-- removes the grant path as well.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON audit_events FROM PUBLIC;
