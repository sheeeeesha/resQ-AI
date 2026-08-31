-- 010_operators
--
-- Operator identity, credentials and sessions.
--
-- Replaces the interim `OPERATOR_TOKENS` environment variable, which had three
-- properties that are acceptable in a prototype and not in a system that
-- records who overrode a life-safety classification:
--
--   1. A token could not be revoked without redeploying the service. An
--      operator leaving the shift, or a token pasted into the wrong window,
--      stayed valid until someone changed an env var and restarted.
--   2. Tokens never expired.
--   3. Every operator had identical capability. Nothing distinguished a
--      call-taker from whoever can release a legal hold.

CREATE TABLE operators (
    operator_id     text        PRIMARY KEY,
    display_name    text        NOT NULL,

    -- Roles are ordered by capability, and each includes those below it. Held
    -- as text rather than an enum so an operating agency can add its own
    -- without a migration; the API validates against its own list.
    --
    --   call_taker  review and correct classifications, dispatch units
    --   supervisor  + legal hold, status changes, audit access
    --   admin       + operator management, retention sweeps
    role            text        NOT NULL DEFAULT 'call_taker',

    -- scrypt. The salt and parameters travel with the hash, so the cost can be
    -- raised later without invalidating existing credentials.
    password_hash   text        NOT NULL,

    -- Disabling is the normal path. Rows are never deleted, because an
    -- operator ID appears throughout the append-only audit trail and a
    -- dangling reference would make a past override unattributable.
    active          boolean     NOT NULL DEFAULT true,
    disabled_at     timestamptz,
    disabled_reason text,

    -- Forces a change on next sign-in. Set when an admin issues a credential.
    must_change_password boolean NOT NULL DEFAULT false,

    last_seen_at    timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX operators_active_idx ON operators (role) WHERE active = true;

ALTER TABLE operators ENABLE ROW LEVEL SECURITY;


-- ---------------------------------------------------------------------------
-- Sessions
-- ---------------------------------------------------------------------------
--
-- Opaque server-side sessions rather than JWTs, deliberately.
--
-- A JWT cannot be revoked before it expires without maintaining a blocklist,
-- which reintroduces the database lookup that was the reason to choose a JWT.
-- In a system where an operator's access may need withdrawing immediately —
-- mid-shift, on a compromised machine — the ability to revoke is worth more
-- than saving a query per request.
--
-- The token is stored hashed. A read of this table yields nothing usable: an
-- attacker with the rows still cannot present a valid session.

CREATE TABLE operator_sessions (
    session_id      uuid        PRIMARY KEY,
    operator_id     text        NOT NULL REFERENCES operators (operator_id),

    -- SHA-256 of the token. Not scrypt: these are 256-bit random values with
    -- no entropy problem, so a slow KDF would add latency to every request and
    -- defend against nothing.
    token_hash      text        NOT NULL UNIQUE,

    issued_at       timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz NOT NULL,
    last_used_at    timestamptz,

    -- Recorded for the audit trail and for showing an operator their own
    -- active sessions. Not used for authorisation: an IP is trivially spoofed
    -- and binding a session to one breaks every mobile network in India.
    issued_ip       text,
    user_agent      text,

    revoked_at      timestamptz,
    revoked_by      text,
    revoked_reason  text
);

-- The lookup on every authenticated request.
CREATE INDEX operator_sessions_active_idx
    ON operator_sessions (token_hash)
    WHERE revoked_at IS NULL;

-- "Show me everything this operator has open", which is what an admin needs
-- when withdrawing access.
CREATE INDEX operator_sessions_operator_idx
    ON operator_sessions (operator_id, issued_at DESC);

-- Expired sessions are swept rather than left to accumulate.
CREATE INDEX operator_sessions_expiry_idx ON operator_sessions (expires_at)
    WHERE revoked_at IS NULL;

ALTER TABLE operator_sessions ENABLE ROW LEVEL SECURITY;


-- ---------------------------------------------------------------------------
-- Authentication events
-- ---------------------------------------------------------------------------
--
-- Separate from `audit_events`, which is scoped to an incident. A failed
-- sign-in belongs to nobody's incident, and forcing it into that table would
-- mean either a fabricated incident reference or a nullable foreign key on the
-- one table whose integrity matters most.
--
-- Append-only for the same reason: an attacker who can delete their own failed
-- attempts leaves no trace of having tried.

CREATE TABLE auth_events (
    event_id        uuid        PRIMARY KEY,
    at              timestamptz NOT NULL DEFAULT now(),

    -- The identifier presented, which may not be a real operator. Recorded as
    -- given so a spray across invented names is visible.
    operator_id     text,
    type            text        NOT NULL,
    ip              text,
    user_agent      text,
    detail          jsonb       NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX auth_events_at_idx ON auth_events (at DESC);
CREATE INDEX auth_events_operator_idx ON auth_events (operator_id, at DESC);

-- Answers "is someone trying passwords against us", which is the question this
-- table exists for.
CREATE INDEX auth_events_failures_idx ON auth_events (at DESC)
    WHERE type = 'sign_in_failed';

ALTER TABLE auth_events ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION auth_events_are_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'auth_events is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER auth_events_append_only
    BEFORE UPDATE OR DELETE ON auth_events
    FOR EACH ROW EXECUTE FUNCTION auth_events_are_append_only();

CREATE TRIGGER auth_events_no_truncate
    BEFORE TRUNCATE ON auth_events
    FOR EACH STATEMENT EXECUTE FUNCTION auth_events_are_append_only();
