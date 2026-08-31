-- 001_init
--
-- Incidents, transcript segments, and the append-only audit log.
--
-- Storage strategy: the field envelopes from @resqai/schema are stored whole,
-- as JSONB, so confidence / evidence / review state survive a round trip
-- intact. Anything the console queries or sorts on is projected out as a
-- GENERATED column, which keeps `fields` the single source of truth — there is
-- no way for a projection to drift out of sync with the value it projects.

CREATE TABLE incidents (
    incident_id             uuid PRIMARY KEY,

    -- Operator-facing reference, e.g. "TS-2026-0830-00417".
    reference               text        NOT NULL UNIQUE,

    status                  text        NOT NULL,
    channel                 text        NOT NULL,
    primary_language        text        NOT NULL,

    -- Hashed, never the raw number. The number itself is personal data under
    -- the DPDP Act and nothing in this system needs to read it back.
    caller_number_hash      text,

    received_at             timestamptz NOT NULL,

    -- All reviewedField envelopes, keyed by field name.
    fields                  jsonb       NOT NULL DEFAULT '{}'::jsonb,

    -- ResolvedLocation: every candidate plus the selection, never flattened
    -- to a single point.
    location                jsonb       NOT NULL
                                        DEFAULT '{"candidates":[],"selected_index":null,"selected_by_human":false,"stated":null}'::jsonb,

    -- The selected candidate, projected for querying. Plain columns rather
    -- than a PostGIS geography type: this is the source of truth in every
    -- environment, and migration 002 adds the spatial type on top of it as a
    -- pure accelerator. Nothing depends on the extension being present.
    location_lat            double precision,
    location_lon            double precision,

    recommended_units       jsonb       NOT NULL DEFAULT '[]'::jsonb,
    dispatched_units        text[]      NOT NULL DEFAULT '{}',

    summary                 text        NOT NULL DEFAULT '',
    transcript_quality      jsonb,

    escalation_triggers     text[]      NOT NULL DEFAULT '{}',
    escalated_at            timestamptz,

    -- Visible operating state. Degradation is never inferred from the absence
    -- of data; it is recorded.
    degraded_mode           boolean     NOT NULL DEFAULT false,

    possible_duplicate_of   uuid        REFERENCES incidents (incident_id),
    overall_confidence      real        NOT NULL DEFAULT 0,

    data_handling           jsonb       NOT NULL
                                        DEFAULT '{"retain_until":null,"may_use_for_training":false,"involves_minor":false,"content_purged":false}'::jsonb,

    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now(),

    -- Optimistic concurrency guard. Every write asserts the version it read.
    version                 integer     NOT NULL DEFAULT 0,

    -- Projections. Immutable JSONB accessors, so these are indexable.
    priority_code           text GENERATED ALWAYS AS (fields -> 'priority' ->> 'value') STORED,
    incident_type_code      text GENERATED ALWAYS AS (fields -> 'incident_type' ->> 'value') STORED,

    CONSTRAINT incidents_version_non_negative CHECK (version >= 0),
    CONSTRAINT incidents_confidence_range CHECK (overall_confidence >= 0 AND overall_confidence <= 1),
    CONSTRAINT incidents_latlon_together CHECK (
        (location_lat IS NULL) = (location_lon IS NULL)
    ),
    CONSTRAINT incidents_lat_range CHECK (
        location_lat IS NULL OR (location_lat >= -90 AND location_lat <= 90)
    ),
    CONSTRAINT incidents_lon_range CHECK (
        location_lon IS NULL OR (location_lon >= -180 AND location_lon <= 180)
    ),
    CONSTRAINT incidents_no_self_duplicate CHECK (possible_duplicate_of <> incident_id)
);

-- The dispatch queue: open incidents, most urgent first. `priority_code` sorts
-- ascending because P0 is the most urgent — the ordering the prototype got
-- backwards by sorting the strings High / Medium / Low descending.
CREATE INDEX incidents_queue_idx
    ON incidents (status, priority_code, received_at DESC);

CREATE INDEX incidents_received_at_idx ON incidents (received_at DESC);
CREATE INDEX incidents_type_idx ON incidents (incident_type_code);

-- Supports duplicate detection by proximity in time before the spatial index
-- exists.
CREATE INDEX incidents_dup_scan_idx ON incidents (received_at)
    WHERE status <> 'merged_duplicate';


-- ---------------------------------------------------------------------------
-- Transcript segments
-- ---------------------------------------------------------------------------
--
-- One row per segment, appended. The prototype stored the whole conversation
-- as a single array and rewrote the entire document on every utterance, which
-- races under concurrent writes and silently drops messages. Rows do not race.

CREATE TABLE transcript_segments (
    incident_id     uuid        NOT NULL REFERENCES incidents (incident_id) ON DELETE CASCADE,

    -- Monotonic within an incident. Doubles as the segment ref: index 12 is "s12".
    idx             integer     NOT NULL,

    speaker         text        NOT NULL,
    text            text        NOT NULL,
    text_en         text,
    language        text        NOT NULL,

    -- Null on text channels, where no recognition step occurred.
    asr_confidence  real,

    start_ms        integer,
    end_ms          integer,
    received_at     timestamptz NOT NULL DEFAULT now(),
    is_final        boolean     NOT NULL DEFAULT true,

    PRIMARY KEY (incident_id, idx),

    CONSTRAINT transcript_asr_confidence_range CHECK (
        asr_confidence IS NULL OR (asr_confidence >= 0 AND asr_confidence <= 1)
    )
);

CREATE INDEX transcript_segments_incident_idx
    ON transcript_segments (incident_id, idx);


-- ---------------------------------------------------------------------------
-- Audit log
-- ---------------------------------------------------------------------------
--
-- Append-only, enforced by the database rather than by convention. This table
-- is the artefact that lets us answer, for any incident, what the system knew,
-- when it knew it, what it proposed, and what a human did about it.
--
-- Corrections are new events. Nothing here is ever updated or deleted.

CREATE TABLE audit_events (
    event_id     uuid        PRIMARY KEY,

    -- Total order across the whole log, independent of clock skew.
    seq          bigint      GENERATED ALWAYS AS IDENTITY,

    incident_id  uuid        NOT NULL REFERENCES incidents (incident_id),
    type         text        NOT NULL,
    at           timestamptz NOT NULL DEFAULT now(),

    -- Null when the system acted on its own rather than a person.
    actor        text,

    field_path   text,
    before       jsonb,
    after        jsonb,
    detail       jsonb       NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX audit_events_incident_idx ON audit_events (incident_id, seq);
CREATE INDEX audit_events_type_idx ON audit_events (type, at DESC);

-- Override-rate reporting reads this constantly: it is the system's primary
-- quality metric, so it gets its own partial index rather than a table scan.
CREATE INDEX audit_events_override_idx
    ON audit_events (field_path, at DESC)
    WHERE type = 'field_overridden';


CREATE FUNCTION reject_audit_mutation() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION
        'audit_events is append-only; % is not permitted', TG_OP
        USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_events_append_only
    BEFORE UPDATE OR DELETE ON audit_events
    FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();

-- TRUNCATE bypasses row-level triggers, so it needs its own statement-level guard.
CREATE TRIGGER audit_events_no_truncate
    BEFORE TRUNCATE ON audit_events
    FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_mutation();
