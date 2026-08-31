-- 002_postgis
--
-- Spatial acceleration. Purely additive: `location_lat` / `location_lon` from
-- migration 001 remain the source of truth, and `location_point` is derived
-- from them, so the two cannot disagree.
--
-- Split into its own migration because PostGIS is not available everywhere the
-- test suite runs. The migration runner skips this file when the extension is
-- absent, which means the foundation stays fully testable without it while
-- production still gets proper spatial indexing.
--
-- Needed from M3 onward, for nearest-unit search and proximity-based duplicate
-- detection.

-- @requires-extension postgis

CREATE EXTENSION IF NOT EXISTS postgis;

ALTER TABLE incidents
    ADD COLUMN location_point geography(Point, 4326)
    GENERATED ALWAYS AS (
        CASE
            WHEN location_lon IS NULL OR location_lat IS NULL THEN NULL
            ELSE ST_SetSRID(ST_MakePoint(location_lon, location_lat), 4326)::geography
        END
    ) STORED;

CREATE INDEX incidents_location_gix ON incidents USING GIST (location_point);

-- Duplicate detection: incidents of the same type reported close together in
-- space and time. New Orleans' deployment uses roughly a 200 m window for the
-- equivalent check; the radius belongs in application config rather than here,
-- so this index only has to make the scan cheap.
CREATE INDEX incidents_dup_spatial_idx
    ON incidents USING GIST (location_point)
    WHERE status <> 'merged_duplicate';
