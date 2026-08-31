-- 005_units
--
-- The response unit registry and the record of what was recommended.
--
-- Two tables with quite different jobs. `response_units` is current state —
-- where each vehicle is and whether it is free. `unit_recommendations` is
-- history — what the system proposed, on what basis, and whether a human acted
-- on it. Keeping them apart matters because the first is overwritten constantly
-- and the second must never be.

CREATE TABLE response_units (
    unit_id         text        PRIMARY KEY,
    name            text        NOT NULL,
    kind            text        NOT NULL,

    -- The operating agency or station this unit belongs to. Free text for now:
    -- a real deployment integrates with an agency roster, and inventing a
    -- normalised org hierarchy before seeing one would be guessing.
    station         text,

    location_lat    double precision NOT NULL,
    location_lon    double precision NOT NULL,


    availability    text        NOT NULL DEFAULT 'unknown',
    contact_number  text,
    address         text,

    -- What this unit can actually do. An ambulance with advanced life support
    -- is a different resource from a patient transport van, and dispatching
    -- the wrong one to a cardiac arrest is a clinical failure, not a
    -- scheduling inefficiency.
    capabilities    jsonb       NOT NULL DEFAULT '[]'::jsonb,

    -- When this unit last reported position or status. A unit that has not
    -- checked in for an hour is not "available", whatever the column says, and
    -- proximity search has to be able to exclude it.
    last_seen_at    timestamptz NOT NULL DEFAULT now(),

    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT response_units_lat_range CHECK (location_lat BETWEEN -90 AND 90),
    CONSTRAINT response_units_lon_range CHECK (location_lon BETWEEN -180 AND 180)
);

-- Bounding-box prefilter for the fallback path used where PostGIS is absent.
-- Migration 006 adds a GIST index that supersedes this for proximity search.
CREATE INDEX response_units_latlon_idx ON response_units (location_lat, location_lon);

-- Proximity search always filters on kind and availability before distance, so
-- a composite index on those pays for itself on every dispatch query.
CREATE INDEX response_units_kind_availability_idx
    ON response_units (kind, availability)
    WHERE availability IN ('available', 'assigned');

CREATE INDEX response_units_last_seen_idx ON response_units (last_seen_at DESC);

ALTER TABLE response_units ENABLE ROW LEVEL SECURITY;


-- ---------------------------------------------------------------------------
-- Recommendations
-- ---------------------------------------------------------------------------
--
-- What the system proposed for an incident, and what happened next.
--
-- Recommendations are never dispatches. Nothing in this system sends a vehicle;
-- it produces a ranked list and a human decides. The `dispatched_at` and
-- `dispatched_by` columns exist to record that human decision, and are null
-- until someone makes it.
--
-- The snapshot columns are deliberate duplication. A unit's position and
-- availability change constantly, so joining to `response_units` later would
-- show where the unit is *now*, not where it was when the recommendation was
-- made. An audit asking "why was this unit chosen" needs the latter.

CREATE TABLE unit_recommendations (
    recommendation_id   uuid        PRIMARY KEY,
    incident_id         uuid        NOT NULL REFERENCES incidents (incident_id) ON DELETE CASCADE,
    unit_id             text        NOT NULL REFERENCES response_units (unit_id),

    -- Position in the ranked list at the time of recommendation.
    rank                integer     NOT NULL,

    -- Distances carry their unit in the name. The prototype computed
    -- kilometres and rendered the result as "miles"; naming the unit in the
    -- column is the cheapest defence against that recurring.
    straight_line_m     double precision NOT NULL,
    road_distance_m     double precision,
    travel_time_s       double precision,

    -- True when travel time was estimated from straight-line distance because
    -- the routing engine was unreachable. Surfaced in the console so nobody
    -- reads a fallback estimate as a routed one.
    is_fallback_estimate boolean    NOT NULL DEFAULT false,

    -- State at the moment of recommendation. See the note above.
    unit_kind           text        NOT NULL,
    unit_availability   text        NOT NULL,
    unit_lat            double precision NOT NULL,
    unit_lon            double precision NOT NULL,

    -- Which incident location the distances were measured from. An incident
    -- location can be corrected later, and a recommendation computed against
    -- the old one has to remain interpretable.
    from_lat            double precision NOT NULL,
    from_lon            double precision NOT NULL,

    recommended_at      timestamptz NOT NULL DEFAULT now(),

    -- Set only when a human dispatches. Never set by the system.
    dispatched_at       timestamptz,
    dispatched_by       text,

    UNIQUE (incident_id, unit_id, recommended_at)
);

CREATE INDEX unit_recommendations_incident_idx
    ON unit_recommendations (incident_id, recommended_at DESC, rank ASC);

-- Answers "which incidents is this unit committed to", which the console needs
-- before proposing it for a second one.
CREATE INDEX unit_recommendations_dispatched_idx
    ON unit_recommendations (unit_id, dispatched_at DESC)
    WHERE dispatched_at IS NOT NULL;

ALTER TABLE unit_recommendations ENABLE ROW LEVEL SECURITY;


-- ---------------------------------------------------------------------------
-- Location ambiguity
-- ---------------------------------------------------------------------------
--
-- The `location` JSONB column already exists from 001 and holds every
-- candidate with its provenance. What it cannot express is *why* no candidate
-- was selected, and that reason is what a call-taker needs to act on:
-- "two trusted sources disagree by 12 km" and "only a landmark, unconfirmed"
-- call for completely different next questions.
--
-- Promoted to its own column rather than kept inside the JSONB because the
-- queue view filters and sorts on it — an incident nobody has pinned down is a
-- different kind of urgent from one that is ready to dispatch.

ALTER TABLE incidents ADD COLUMN location_ambiguity text;

CREATE INDEX incidents_location_ambiguity_idx
    ON incidents (received_at DESC)
    WHERE location_ambiguity IS NOT NULL;
