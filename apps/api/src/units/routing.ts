import { distanceMetres } from "../location/resolve.js";

/**
 * Road routing.
 *
 * The distinction this module protects is the difference between how far away
 * something is and how long it takes to get there. In an Indian city those are
 * barely related: a rail crossing, a one-way flyover, a divided highway with a
 * U-turn two kilometres on, or a market street at 6pm routinely make the
 * nearest unit by straight line the slowest to arrive.
 *
 * So dispatch ranks on travel time from a routing engine. Straight-line
 * distance remains as a fallback for when that engine is unreachable, and every
 * result it produces is flagged, because an unlabelled fallback estimate is
 * indistinguishable from a real one at exactly the moment it matters.
 */

export interface RouteRequest {
  from: { latitude: number; longitude: number };
  to: Array<{ latitude: number; longitude: number }>;
}

export interface RouteLeg {
  /** Road network distance in metres. Null when only an estimate was possible. */
  road_distance_m: number | null;
  /** Travel time in seconds. The number dispatch actually ranks on. */
  travel_time_s: number | null;
  /** Great-circle distance. Always present; never authoritative. */
  straight_line_m: number;
  /** True when the figures were derived from straight-line distance. */
  is_fallback_estimate: boolean;
}

export interface RoutingProvider {
  readonly name: string;
  /** One leg per destination, in the order given. */
  route(request: RouteRequest): Promise<RouteLeg[]>;
}

/**
 * Average effective speed for the straight-line fallback, in metres/second.
 *
 * 6.9 m/s is about 25 km/h. That is deliberately pessimistic against open-road
 * speed and roughly matches observed emergency-vehicle averages in dense Indian
 * urban traffic. It is a stand-in, not a model: it takes no account of the time
 * of day, the road class, or the direction of travel, which is precisely why
 * everything it produces is flagged as an estimate.
 */
const FALLBACK_SPEED_MPS = 6.9;

/**
 * Multiplier converting straight-line distance to plausible road distance.
 *
 * Real road networks are not straight. 1.4 is a common urban circuity factor
 * and is applied so the fallback does not systematically under-report how far a
 * unit has to travel — under-reporting distance means over-promising arrival,
 * which is the more harmful direction of error.
 */
const CIRCUITY_FACTOR = 1.4;

/** Estimates a leg from straight-line distance alone. Always flagged. */
export function estimateLeg(
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number },
): RouteLeg {
  const straight = distanceMetres(from, to);
  const road = straight * CIRCUITY_FACTOR;

  return {
    road_distance_m: Math.round(road),
    travel_time_s: Math.round(road / FALLBACK_SPEED_MPS),
    straight_line_m: Math.round(straight),
    is_fallback_estimate: true,
  };
}

/** Used when no routing engine is configured. Honest about being an estimate. */
export class StraightLineRouter implements RoutingProvider {
  readonly name = "straight-line";

  async route(request: RouteRequest): Promise<RouteLeg[]> {
    return request.to.map((destination) => estimateLeg(request.from, destination));
  }
}

/* ------------------------------------------------------------------ *
 * OSRM
 * ------------------------------------------------------------------ */

interface OsrmTableResponse {
  code?: string;
  durations?: Array<Array<number | null>>;
  distances?: Array<Array<number | null>>;
}

/**
 * OSRM, via the Table service.
 *
 * One request covers every candidate unit rather than one request per unit —
 * with a dozen units in range that is the difference between a single round
 * trip and twelve, on a path where seconds are the entire point.
 *
 * The public demo server at router.project-osrm.org is fine for development and
 * explicitly not for production use. A self-hosted OSRM with an India extract
 * is the deployment answer, and needs no code change here beyond the base URL.
 *
 * Every failure degrades to a flagged straight-line estimate rather than
 * failing the dispatch recommendation. A rough ordering now beats a precise one
 * that arrives after the caller has hung up.
 */
export class OsrmRouter implements RoutingProvider {
  readonly name = "osrm";

  constructor(
    private readonly config: {
      baseUrl: string;
      timeoutMs?: number;
      /** Routing profile. OSRM extracts are built per profile. */
      profile?: "driving" | "car";
    },
  ) {}

  async route(request: RouteRequest): Promise<RouteLeg[]> {
    if (request.to.length === 0) return [];

    // OSRM takes longitude,latitude. Getting this backwards is the classic
    // error with this API and produces a route in the wrong hemisphere rather
    // than an error, so the ordering is written out explicitly here.
    const coordinates = [request.from, ...request.to]
      .map((point) => `${point.longitude},${point.latitude}`)
      .join(";");

    const profile = this.config.profile ?? "driving";
    const url = new URL(
      `${this.config.baseUrl.replace(/\/+$/, "")}/table/v1/${profile}/${coordinates}`,
    );
    url.searchParams.set("sources", "0");
    url.searchParams.set(
      "destinations",
      request.to.map((_, index) => index + 1).join(";"),
    );
    url.searchParams.set("annotations", "duration,distance");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 4_000);

    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) return this.fallback(request);

      const body = (await response.json()) as OsrmTableResponse;
      if (body.code !== "Ok" || !body.durations?.[0]) return this.fallback(request);

      const durations = body.durations[0];
      const distances = body.distances?.[0];

      return request.to.map((destination, index) => {
        const duration = durations[index];
        const distance = distances?.[index];

        // OSRM returns null for a destination it cannot reach from the source
        // — an island, a gated area, a gap in the extract. That unit gets a
        // flagged estimate rather than being dropped, because "unreachable by
        // the road graph we have" is not the same as "unreachable".
        if (duration == null) {
          return estimateLeg(request.from, destination);
        }

        return {
          road_distance_m: distance == null ? null : Math.round(distance),
          travel_time_s: Math.round(duration),
          straight_line_m: Math.round(distanceMetres(request.from, destination)),
          is_fallback_estimate: false,
        };
      });
    } catch {
      return this.fallback(request);
    } finally {
      clearTimeout(timer);
    }
  }

  private fallback(request: RouteRequest): RouteLeg[] {
    return request.to.map((destination) => estimateLeg(request.from, destination));
  }
}
