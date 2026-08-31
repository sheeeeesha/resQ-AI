-- 012_revoke_defaults
--
-- Removes Supabase's default grants to `anon` and `authenticated`.
--
-- Supabase grants both roles broad table privileges on `public` as a
-- convenience, on the assumption that RLS policies do the real gatekeeping.
-- Auditing this project after 011 found 210 such grants still in place.
--
-- Nothing is currently exposed by them: RLS is on with no policy naming either
-- role, so every read and write is denied. But that means the entire
-- protection rests on one property of one table staying true. A table created
-- without `ENABLE ROW LEVEL SECURITY`, or a policy added later that is broader
-- than intended, turns 210 dormant grants into live access to emergency call
-- data — and nothing would report that it had.
--
-- Revoking makes the denial structural rather than conditional. Two
-- independent mechanisms have to fail before anything is reachable, which is
-- the same reasoning behind the audit log having both a trigger and a withheld
-- grant.
--
-- This costs nothing the project uses. The console holds no database
-- credentials and talks only to the API; Supabase Realtime is not used, since
-- live updates come from the API over SSE; and the Supabase dashboard connects
-- as the owner rather than as `anon`.

DO $$
DECLARE
    target text;
BEGIN
    FOREACH target IN ARRAY ARRAY['anon', 'authenticated'] LOOP
        -- The role may not exist outside Supabase — this migration has to run
        -- against a plain Postgres and against PGlite in the test suite.
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = target) THEN
            EXECUTE format(
                'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', target
            );
            EXECUTE format(
                'REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', target
            );
            EXECUTE format(
                'REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', target
            );

            -- Stops the grants reappearing on tables created later. Without
            -- this, Supabase's default privileges would quietly re-grant on
            -- the next migration that adds a table.
            EXECUTE format(
                'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I',
                target
            );
            EXECUTE format(
                'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I',
                target
            );
        END IF;
    END LOOP;
END
$$;

-- Schema usage goes too. Without it a role cannot address a table by name even
-- if some future grant slips through.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE USAGE ON SCHEMA public FROM anon;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE USAGE ON SCHEMA public FROM authenticated;
    END IF;
END
$$;
