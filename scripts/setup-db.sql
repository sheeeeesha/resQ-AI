-- Creates the ResQAI role, database and extensions.
--
-- Run once as a superuser:
--   psql -U postgres -h localhost -v pw="$(openssl rand -hex 16)" -f scripts/setup-db.sql
--
-- Idempotent: safe to re-run. Postgres has no CREATE ROLE IF NOT EXISTS, hence
-- the DO block; CREATE DATABASE cannot run inside one, hence the \gexec.

\set ON_ERROR_STOP on

DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'resqai') THEN
        EXECUTE format('CREATE ROLE resqai LOGIN PASSWORD %L', :'pw');
        RAISE NOTICE 'created role resqai';
    ELSE
        EXECUTE format('ALTER ROLE resqai PASSWORD %L', :'pw');
        RAISE NOTICE 'role resqai already existed; password reset';
    END IF;
END
$$;

SELECT 'CREATE DATABASE resqai OWNER resqai'
 WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'resqai')\gexec

\connect resqai

-- Optional. Absent PostGIS, migration 002 is skipped and proximity search is
-- unavailable; everything else works unchanged.
CREATE EXTENSION IF NOT EXISTS postgis;

GRANT ALL ON SCHEMA public TO resqai;

\echo ''
\echo 'Done. Connection string:'
\echo '  postgres://resqai:<password>@localhost:5432/resqai'
