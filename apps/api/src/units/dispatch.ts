import type {
  ResponseAgency,
  ResponseUnit,
  ResponseUnitKind,
  ResolvedLocation,
} from "@resqai/schema";

import type { UnitRepository, UnitRow } from "./repository.js";
import type { RoutingProvider } from "./routing.js";

/**
 * Dispatch recommendation.
 *
 * Produces a ranked list of units for a call-taker to choose from. It does not
 * dispatch anything, and there is no code path in this system that does — the
 * only thing that sets `dispatched_at` is an operator action carrying an
 * operator ID.
 *
 * The rule that shapes everything else here: **an unconfirmed location
 * produces no recommendation at all.** Recommending against an ambiguous
 * location means computing distances from a point nobody has verified, ranking
 * them precisely, and presenting the result with the same confidence as a real
 * one. A dispatcher reading "Ambulance 12 — 4 minutes" has no way to know the
 * four minutes were measured from a guess.
 */

/**
 * Which unit kinds serve which dispatch lane.
 *
 * Several lanes map to police vehicles, which is not a modelling shortcut —
 * ERSS-112 routes women's and children's cases through police response in
 * practice. The lane is preserved separately on the incident so the distinction
 * survives even where the responding vehicle is the same.
 */
const AGENCY_UNITS: Record<ResponseAgency, ResponseUnitKind[]> = {
  police: ["police_vehicle", "police_station"],
  health: ["ambulance", "hospital"],
  fire: ["fire_tender", "fire_station"],
  disaster: ["rescue_team", "fire_tender"],
  women: ["police_vehicle", "police_station"],
  children: ["police_vehicle", "police_station"],
  railways: ["police_vehicle", "rescue_team"],
};

/**
 * Search radius by priority, in metres.
 *
 * A P0 search goes wider because at that priority a slower unit still beats no
 * unit. A routine case searching 25 km would propose vehicles that should stay
 * where they are for something more urgent — the radius is a resource
 * allocation decision as much as a geographic one.
 */
const RADIUS_BY_PRIORITY: Record<string, number> = {
  P0_immediate: 25_000,
  P1_urgent: 15_000,
  P2_prompt: 10_000,
  P3_routine: 7_000,
  P4_referral: 5_000,
};

export interface DispatchRequest {
  location: ResolvedLocation;
  agencies: ResponseAgency[];
  priority: string | null;
  /** How many units to return per agency lane. */
  perAgency?: number;
}

export interface DispatchRecommendation {
  /** Ranked units, best first. Empty when no recommendation could be made. */
  units: ResponseUnit[];
  /** The point distances were measured from. Null when none was usable. */
  from: { latitude: number; longitude: number } | null;
  /**
   * Why no recommendation was produced. Null when units were found.
   *
   * Always populated when `units` is empty, because "no ambulance nearby" and
   * "we do not know where this is" call for completely different actions from
   * the call-taker, and an empty list alone cannot distinguish them.
   */
  blocked_reason: string | null;
  /** True when travel times are straight-line estimates rather than routed. */
  degraded_routing: boolean;
}

export class DispatchService {
  constructor(
    private readonly units: UnitRepository,
    private readonly router: RoutingProvider,
  ) {}

  async recommend(request: DispatchRequest): Promise<DispatchRecommendation> {
    const empty = (reason: string): DispatchRecommendation => ({
      units: [],
      from: null,
      blocked_reason: reason,
      degraded_routing: false,
    });

    // The location gate. Everything below depends on a point that a human has
    // either confirmed or that came from a source trustworthy enough not to
    // need confirmation.
    const selected =
      request.location.selected_index === null
        ? null
        : (request.location.candidates[request.location.selected_index] ?? null);

    if (!selected) {
      return empty(
        request.location.candidates.length === 0
          ? "No location for this incident yet."
          : "Location is not confirmed. Select a candidate before dispatching.",
      );
    }

    if (request.agencies.length === 0) {
      return empty("No response agency has been determined yet.");
    }

    const from = selected.point;
    const kinds = [
      ...new Set(request.agencies.flatMap((agency) => AGENCY_UNITS[agency] ?? [])),
    ];

    const radiusM = RADIUS_BY_PRIORITY[request.priority ?? "P2_prompt"] ?? 10_000;
    const perAgency = request.perAgency ?? 3;
    const limit = perAgency * request.agencies.length;

    let nearby = await this.units.nearest({ point: from, kinds, radiusM, limit });

    // Nothing free within the radius: widen to committed units so the
    // dispatcher can see what exists and make a reassignment call, rather than
    // reading an empty list as "no units exist".
    let reassignmentOnly = false;
    if (nearby.length === 0) {
      nearby = await this.units.nearest({
        point: from,
        kinds,
        radiusM,
        limit,
        availability: ["assigned", "en_route"],
      });
      reassignmentOnly = nearby.length > 0;
    }

    if (nearby.length === 0) {
      return {
        units: [],
        from,
        blocked_reason: `No units of the required kind within ${Math.round(radiusM / 1000)} km.`,
        degraded_routing: false,
      };
    }

    // Straight-line ordering got us a shortlist cheaply. Road travel time
    // decides the actual ranking, and frequently reorders it.
    const legs = await this.router.route({
      from,
      to: nearby.map((unit) => ({
        latitude: unit.location_lat,
        longitude: unit.location_lon,
      })),
    });

    const withRoutes: ResponseUnit[] = nearby.map((unit, index) => {
      const leg = legs[index];
      return {
        unit_id: unit.unit_id,
        name: unit.name,
        kind: unit.kind,
        point: { latitude: unit.location_lat, longitude: unit.location_lon },
        road_distance_m: leg?.road_distance_m ?? null,
        travel_time_s: leg?.travel_time_s ?? null,
        straight_line_m: Math.round(unit.straight_line_m),
        is_fallback_estimate: leg?.is_fallback_estimate ?? true,
        availability: unit.availability,
        contact_number: unit.contact_number,
        address: unit.address,
      };
    });

    const ranked = rankByArrival(withRoutes);
    const balanced = takePerKind(ranked, perAgency, request.agencies.length);

    return {
      units: balanced,
      from,
      blocked_reason: reassignmentOnly
        ? "No free units in range. These are committed elsewhere and would need reassigning."
        : null,
      degraded_routing: balanced.some((unit) => unit.is_fallback_estimate),
    };
  }
}

/**
 * Orders units by how soon they can arrive.
 *
 * Travel time first, because that is the question. Straight-line distance
 * breaks ties only when travel time is missing for both — never as the primary
 * key, which is the mistake that makes the unit across the river look closest.
 */
function rankByArrival(units: ResponseUnit[]): ResponseUnit[] {
  return [...units].sort((a, b) => {
    if (a.travel_time_s !== null && b.travel_time_s !== null) {
      return a.travel_time_s - b.travel_time_s;
    }
    // A routed unit sorts above an unrouted one at equal apparent distance:
    // its number is real and the other is a guess.
    if (a.travel_time_s !== null) return -1;
    if (b.travel_time_s !== null) return 1;
    return a.straight_line_m - b.straight_line_m;
  });
}

/**
 * Keeps the list balanced across unit kinds.
 *
 * A structure fire with people trapped routes both fire and health. Ranking
 * purely by arrival time would fill the whole list with fire tenders from the
 * station next door and show no ambulance at all — technically the fastest
 * units, and useless to the person who has to send both.
 */
function takePerKind(
  ranked: ResponseUnit[],
  perKind: number,
  maxKinds: number,
): ResponseUnit[] {
  const counts = new Map<ResponseUnitKind, number>();
  const out: ResponseUnit[] = [];

  for (const unit of ranked) {
    const taken = counts.get(unit.kind) ?? 0;
    if (taken >= perKind) continue;
    counts.set(unit.kind, taken + 1);
    out.push(unit);
    if (out.length >= perKind * maxKinds) break;
  }

  return out;
}
