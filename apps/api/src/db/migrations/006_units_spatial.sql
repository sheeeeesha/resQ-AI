-- 006_units_spatial
--
-- Spatial acceleration for the unit registry. Additive, exactly as 002 was for
-- incidents: `location_lat` / `location_lon` from 005 stay the source of truth
-- and `location_point` is generated from them, so the two cannot disagree.
--
-- Split out because PostGIS is not available everywhere the test suite runs.
-- The runner skips this file when the extension is absent, and the repository
-- detects its absence and falls back to a bounding-box prefilter with the
-- distance computed in SQL.
--
-- That fallback is not a token gesture. It means the whole dispatch path —
-- proximity, ranking, recommendation, the location gate — is exercised by the
-- test suite with no database server and no extension, which is the property
-- that has kept this project testable from M1.

-- @requires-extension postgis

ALTER TABLE response_units
    ADD COLUMN location_point geography(Point, 4326)
    GENERATED ALWAYS AS (
        ST_SetSRID(ST_MakePoint(location_lon, location_lat), 4326)::geography
    ) STORED;

-- The index the nearest-unit query exists to use. Turns "closest available
-- ambulance within 15 km" from a full table sweep into an index scan, which is
-- the difference between demo scale and fleet scale.
CREATE INDEX response_units_location_gix ON response_units USING GIST (location_point);
