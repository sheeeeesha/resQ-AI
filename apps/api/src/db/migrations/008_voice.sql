-- 008_voice
--
-- Call lifecycle.
--
-- A call is not a message. It has a duration, it can be answered or abandoned,
-- and the system has to be useful while it is still happening — so it needs a
-- record of its own rather than being inferred from the transcript.
--
-- The columns that matter most are the timing ones. `first_triage_ms` is the
-- number this whole milestone is judged on: how long from the call connecting
-- until a call-taker had a usable lane and priority. The reference result in
-- this field turned on exactly that measure, and a system that cannot report
-- it cannot be evaluated against one.

CREATE TABLE voice_calls (
    call_id             text        PRIMARY KEY,
    incident_id         uuid        NOT NULL REFERENCES incidents (incident_id) ON DELETE CASCADE,

    -- Telephony provider and its own call identifier, for reconciling against
    -- the carrier's records during an audit.
    provider            text        NOT NULL,
    direction           text        NOT NULL DEFAULT 'inbound',

    -- Which recogniser produced this transcript, and which version. Without it
    -- a past transcript cannot be attributed, and an accuracy regression
    -- cannot be told apart from a change in the calls themselves.
    asr_engine          text,

    started_at          timestamptz NOT NULL DEFAULT now(),
    answered_at         timestamptz,
    ended_at            timestamptz,

    -- Why the call ended. An abandoned call is operationally different from a
    -- completed one: someone dialled 112 and hung up, and that may itself
    -- warrant a callback.
    end_reason          text,

    -- Time from call start to the first usable classification, in
    -- milliseconds. Null while the call is live or if triage never settled.
    first_triage_ms     integer,

    -- Pass counts, for cost and latency reporting per call.
    triage_passes       integer     NOT NULL DEFAULT 0,
    full_passes         integer     NOT NULL DEFAULT 0,

    created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX voice_calls_incident_idx ON voice_calls (incident_id);
CREATE INDEX voice_calls_started_idx ON voice_calls (started_at DESC);

-- Live calls, which the console shows differently from settled incidents.
CREATE INDEX voice_calls_live_idx ON voice_calls (started_at DESC)
    WHERE ended_at IS NULL;

ALTER TABLE voice_calls ENABLE ROW LEVEL SECURITY;


-- The recogniser that produced an incident's transcript, denormalised onto the
-- incident so the console can show it without a join on every read.
ALTER TABLE incidents ADD COLUMN asr_engine text;
