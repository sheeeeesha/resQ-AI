import { randomUUID } from "node:crypto";
import type {
  ResponseUnit,
  ResponseUnitKind,
  UnitAvailability,
} from "@resqai/schema";
import type { Db, Row } from "../db/driver.js";
import type { RoutingProvider } from "./routing.js";

/**
 * The response unit registry and proximity search.
 *
 * Proximity search runs in Postgres rather than in Node. Pulling every unit
 * into memory to sort by distance works at demo scale and stops working at the
 * scale that matters; PostGIS with a GIST index answers "nearest available
 * ambulance within 15 km" as an index scan regardless of fleet size.
 */

export interface NearestQuery {
  point: { latitude: number; longitude: number };
  kinds: ResponseUnitKind[];
  /** Search radius in metres. */
  radiusM: number;
  limit?: number;
  /**
   * Availability states to include.
   *
   * Defaults to `available` only. `assigned` is includable on purpose: when
   * nothing is free, a dispatcher needs to see what is committed elsewhere so
   * they can make a reassignment decision rather than an empty list.
   */
  availability?: UnitAvailability[];
  /**
   * Ignore units whose last check-in is older than this, in seconds.
   *
   * A vehicle that has not reported for an hour is not meaningfully
   * "available" whatever its row says, and recommending it wastes the minutes
   * that mattered most.
   */
  maxStalenessS?: number;
}

export interface UnitRow {
  unit_id: string;
  name: string;
  kind: ResponseUnitKind;
  station: string | null;
  location_lat: number;
  location_lon: number;
  availability: UnitAvailability;
  contact_number: string | null;
  address: string | null;
  capabilities: string[];
  last_seen_at: string;
  straight_line_m: number;
}

/** Shared projection so the two proximity queries cannot drift apart. */
const UNIT_COLUMNS = `
  unit_id, name, kind, station, location_lat, location_lon,
  availability, contact_number, address, capabilities, last_seen_at
`;

/**
 * Proximity search with PostGIS.
 *
 * `ST_DWithin` on a geography column uses the GIST index, and `<->` gives an
 * index-ordered nearest-neighbour scan. Both matter at fleet scale.
 */
const SPATIAL_NEAREST = `
  SELECT ${UNIT_COLUMNS},
         ST_Distance(
           location_point,
           ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography
         ) AS straight_line_m
    FROM response_units
   WHERE kind = ANY($3)
     AND availability = ANY($4)
     AND last_seen_at > now() - make_interval(secs => $6)
     AND ST_DWithin(
           location_point,
           ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography,
           $5
         )
   ORDER BY location_point <-> ST_SetSRID(ST_MakePoint($2, $1), 4326)::geography
   LIMIT $7
`;

/**
 * The same search without PostGIS.
 *
 * A latitude/longitude bounding box narrows the scan using a plain btree
 * index, then the haversine distance is computed in SQL and filtered exactly.
 * The box is generous — it is a prefilter, not the answer — because a box that
 * clips the circle would silently drop units near the radius edge.
 *
 * Slower than the spatial path and identical in result, which is the point:
 * every dispatch behaviour stays testable with no extension installed.
 */
const FALLBACK_NEAREST = `
  SELECT * FROM (
    SELECT ${UNIT_COLUMNS},
           6371000 * 2 * asin(sqrt(
             power(sin(radians(location_lat - $1) / 2), 2) +
             cos(radians($1)) * cos(radians(location_lat)) *
             power(sin(radians(location_lon - $2) / 2), 2)
           )) AS straight_line_m
      FROM response_units
     WHERE kind = ANY($3)
       AND availability = ANY($4)
       AND last_seen_at > now() - make_interval(secs => $6)
       AND location_lat BETWEEN $1 - ($5 / 111320.0) AND $1 + ($5 / 111320.0)
       AND location_lon BETWEEN
             $2 - ($5 / (111320.0 * greatest(cos(radians($1)), 0.01)))
         AND $2 + ($5 / (111320.0 * greatest(cos(radians($1)), 0.01)))
  ) AS candidates
  WHERE straight_line_m <= $5
  ORDER BY straight_line_m ASC
  LIMIT $7
`;

export class UnitRepository {
  constructor(private readonly db: Db) {}

  /** Registers or updates a unit. Used by roster sync and by seeding. */
  async upsert(unit: {
    unit_id: string;
    name: string;
    kind: ResponseUnitKind;
    latitude: number;
    longitude: number;
    station?: string | null;
    availability?: UnitAvailability;
    contact_number?: string | null;
    address?: string | null;
    capabilities?: string[];
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO response_units
         (unit_id, name, kind, station, location_lat, location_lon,
          availability, contact_number, address, capabilities, last_seen_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now(), now())
       ON CONFLICT (unit_id) DO UPDATE SET
         name = EXCLUDED.name,
         kind = EXCLUDED.kind,
         station = EXCLUDED.station,
         location_lat = EXCLUDED.location_lat,
         location_lon = EXCLUDED.location_lon,
         availability = EXCLUDED.availability,
         contact_number = EXCLUDED.contact_number,
         address = EXCLUDED.address,
         capabilities = EXCLUDED.capabilities,
         last_seen_at = now(),
         updated_at = now()`,
      [
        unit.unit_id,
        unit.name,
        unit.kind,
        unit.station ?? null,
        unit.latitude,
        unit.longitude,
        unit.availability ?? "unknown",
        unit.contact_number ?? null,
        unit.address ?? null,
        JSON.stringify(unit.capabilities ?? []),
      ],
    );
  }

  /** Updates position and availability without touching the rest of the row. */
  async reportStatus(
    unitId: string,
    status: {
      latitude?: number;
      longitude?: number;
      availability?: UnitAvailability;
    },
  ): Promise<void> {
    await this.db.query(
      `UPDATE response_units SET
         location_lat = COALESCE($2, location_lat),
         location_lon = COALESCE($3, location_lon),
         availability = COALESCE($4, availability),
         last_seen_at = now(),
         updated_at = now()
       WHERE unit_id = $1`,
      [
        unitId,
        status.latitude ?? null,
        status.longitude ?? null,
        status.availability ?? null,
      ],
    );
  }

  /**
   * Nearest units of the given kinds, by straight-line distance.
   *
   * Straight-line ordering here is a *pre-filter*, not the recommendation. It
   * narrows a fleet to a handful of plausible candidates cheaply and with an
   * index; the routing engine then reorders those few by travel time, which is
   * what actually decides who goes. Routing every unit in the fleet would be
   * both slow and pointless.
   *
   * The pre-filter is intentionally wider than the final list for that reason:
   * the closest unit by road is frequently not the closest by line.
   */
  async nearest(query: NearestQuery): Promise<UnitRow[]> {
    if (query.kinds.length === 0) return [];

    const availability = query.availability ?? ["available"];
    const limit = query.limit ?? 10;
    const params = [
      query.point.latitude,
      query.point.longitude,
      query.kinds,
      availability,
      query.radiusM,
      query.maxStalenessS ?? 3600,
      // Over-fetch, then let routing reorder. Three times the requested count
      // is enough for road distance to reshuffle the ranking without making
      // the routing call expensive.
      limit * 3,
    ];

    return (await this.hasSpatial())
      ? this.db.query<UnitRow>(SPATIAL_NEAREST, params)
      : this.db.query<UnitRow>(FALLBACK_NEAREST, params);
  }

  /**
   * Whether the spatial column exists, cached after the first check.
   *
   * Detected rather than configured. A deployment where someone forgot to
   * enable PostGIS should degrade to a correct-but-slower query, not emit SQL
   * that fails at dispatch time — which is the worst possible moment to
   * discover a missing extension.
   */
  private spatial: boolean | null = null;

  private async hasSpatial(): Promise<boolean> {
    if (this.spatial !== null) return this.spatial;

    const rows = await this.db.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM information_schema.columns
        WHERE table_name = 'response_units' AND column_name = 'location_point'`,
    );
    this.spatial = Number(rows[0]?.count ?? 0) > 0;
    return this.spatial;
  }

  async byId(unitId: string): Promise<Row | null> {
    const rows = await this.db.query(
      `SELECT unit_id, name, kind, station, location_lat, location_lon,
              availability, contact_number, address, capabilities, last_seen_at
         FROM response_units WHERE unit_id = $1`,
      [unitId],
    );
    return rows[0] ?? null;
  }

  async count(): Promise<number> {
    const rows = await this.db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM response_units",
    );
    return Number(rows[0]?.count ?? 0);
  }

  /* ---------------- recommendations ---------------- */

  /**
   * Stores a ranked recommendation set.
   *
   * Unit state is snapshotted rather than referenced. Units move constantly, so
   * joining back to `response_units` during an audit would show where a vehicle
   * is now, not where it was when it was recommended — and "why was this unit
   * chosen" is a question that can only be answered with the latter.
   */
  async recordRecommendations(
    incidentId: string,
    from: { latitude: number; longitude: number },
    units: ResponseUnit[],
  ): Promise<void> {
    if (units.length === 0) return;

    await this.db.transaction(async (tx) => {
      for (const [index, unit] of units.entries()) {
        await tx.query(
          `INSERT INTO unit_recommendations
             (recommendation_id, incident_id, unit_id, rank,
              straight_line_m, road_distance_m, travel_time_s, is_fallback_estimate,
              unit_kind, unit_availability, unit_lat, unit_lon, from_lat, from_lon)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [
            randomUUID(),
            incidentId,
            unit.unit_id,
            index,
            unit.straight_line_m,
            unit.road_distance_m,
            unit.travel_time_s,
            unit.is_fallback_estimate,
            unit.kind,
            unit.availability,
            unit.point.latitude,
            unit.point.longitude,
            from.latitude,
            from.longitude,
          ],
        );
      }
    });
  }

  /** The most recent recommendation set for an incident. */
  async latestRecommendations(incidentId: string): Promise<Row[]> {
    return this.db.query(
      `SELECT r.* FROM unit_recommendations r
        WHERE r.incident_id = $1
          AND r.recommended_at = (
            SELECT max(recommended_at) FROM unit_recommendations
             WHERE incident_id = $1
          )
        ORDER BY r.rank ASC`,
      [incidentId],
    );
  }

  /**
   * Marks a unit as dispatched to an incident.
   *
   * The only place `dispatched_at` is ever set, and it requires an operator ID.
   * Nothing in this system dispatches on its own; the column exists to record a
   * decision a person made, and an unattributed dispatch would defeat the
   * entire point of the audit trail.
   */
  async markDispatched(
    incidentId: string,
    unitId: string,
    operatorId: string,
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const updated = await tx.query<{ recommendation_id: string }>(
        `UPDATE unit_recommendations
            SET dispatched_at = now(), dispatched_by = $3
          WHERE incident_id = $1 AND unit_id = $2 AND dispatched_at IS NULL
          RETURNING recommendation_id`,
        [incidentId, unitId, operatorId],
      );

      if (updated.length === 0) return false;

      await tx.query(
        `UPDATE response_units
            SET availability = 'assigned', updated_at = now()
          WHERE unit_id = $1 AND availability = 'available'`,
        [unitId],
      );

      return true;
    });
  }
}
