-- 004_intake
--
-- Exactly-once message ingest.
--
-- Every text channel we accept redelivers. WhatsApp retries a webhook until it
-- receives a 2xx, SMS gateways redeliver on timeout, and a caller refreshing a
-- web form resubmits it. Without a guard, one message becomes several
-- transcript segments, and the extractor sees a caller who said "there's a fire"
-- three times — which reads as emphasis, or as three separate reports.
--
-- The vendor's own message ID is the natural idempotency key, so it is stored
-- with a unique constraint and the ingest path defers to it.

CREATE TABLE intake_messages (
    -- The provider's message ID, namespaced by channel. Two providers could
    -- independently mint the same opaque ID; the channel prefix keeps them apart.
    external_id     text        PRIMARY KEY,

    channel         text        NOT NULL,
    incident_id     uuid        NOT NULL REFERENCES incidents (incident_id) ON DELETE CASCADE,

    -- Which transcript segment this message became.
    segment_idx     integer     NOT NULL,

    received_at     timestamptz NOT NULL DEFAULT now(),

    UNIQUE (incident_id, segment_idx)
);

CREATE INDEX intake_messages_incident_idx ON intake_messages (incident_id, segment_idx);

ALTER TABLE intake_messages ENABLE ROW LEVEL SECURITY;


-- ---------------------------------------------------------------------------
-- Open conversation lookup
-- ---------------------------------------------------------------------------
--
-- A second WhatsApp message from the same number is a continuation of the same
-- emergency, not a new one. Finding the open incident for a caller has to be
-- cheap because it happens on every inbound message.
--
-- Partial index: only open incidents are candidates. Once an incident is
-- resolved or cancelled, the next message from that number legitimately starts
-- a new one.

CREATE INDEX incidents_open_by_caller_idx
    ON incidents (caller_number_hash, received_at DESC)
    WHERE status IN ('active_call', 'awaiting_confirmation');


-- ---------------------------------------------------------------------------
-- Extraction history
-- ---------------------------------------------------------------------------
--
-- One row per extraction pass. Kept separate from the incident because the
-- incident holds current state while this holds how that state was arrived at:
-- which model, which prompt version, how long it took, what it proposed.
--
-- This is what makes a past classification reproducible. Without the model ID
-- and prompt version recorded per pass, an audit trail can say what the system
-- concluded but not why, and cannot distinguish a model regression from a
-- change in the calls themselves.

CREATE TABLE extraction_passes (
    pass_id                 uuid        PRIMARY KEY,
    incident_id             uuid        NOT NULL REFERENCES incidents (incident_id) ON DELETE CASCADE,

    pass                    integer     NOT NULL,
    through_segment_index   integer     NOT NULL,

    -- The raw IncidentExtraction as returned, before merge.
    result                  jsonb,

    model_id                text        NOT NULL,
    prompt_version          text        NOT NULL,
    contract_version        text        NOT NULL,
    latency_ms              integer     NOT NULL,

    -- Semantic problems found after decoding. Recorded rather than raised:
    -- on a live call a partial extraction beats no extraction.
    problems                text[]      NOT NULL DEFAULT '{}',

    -- Set when the pass failed outright.
    error                   text,

    created_at              timestamptz NOT NULL DEFAULT now(),

    UNIQUE (incident_id, pass)
);

CREATE INDEX extraction_passes_incident_idx ON extraction_passes (incident_id, pass DESC);

-- Model-quality reporting reads this: latency and problem counts by model.
CREATE INDEX extraction_passes_model_idx ON extraction_passes (model_id, created_at DESC);

ALTER TABLE extraction_passes ENABLE ROW LEVEL SECURITY;
