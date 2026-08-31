import {
  LOCATION_SOURCE_TRUST,
  rankCandidates,
  type LocationCandidate,
  type LocationSource,
  type ResolvedLocation,
  type StatedLocation,
} from "@resqai/schema";

import { extractLocations } from "./extract.js";
import type { GeocodeProvider } from "./geocode.js";

/**
 * Location resolution.
 *
 * Gathers every candidate from every available source, ranks them by how much
 * the source deserves to be trusted, and then makes the decision that actually
 * matters: whether to select one at all.
 *
 * Selecting is the dangerous act. A selected location is what the console
 * displays, what proximity search runs against, and what a dispatcher acts on.
 * Two candidates 12 km apart must not silently become the higher-ranked one —
 * a call-taker needs to see that there is a question. So selection happens only
 * when the evidence genuinely agrees, and stays null otherwise.
 */

/**
 * How far apart two candidates can be and still be "the same place".
 *
 * 250 m is about a city block. Within that, either answer routes a vehicle to
 * effectively the same spot and the distinction is not worth an operator's
 * attention. Beyond it, the difference can decide which side of a divided
 * highway or which of two adjacent localities a unit is sent to.
 */
const AGREEMENT_RADIUS_M = 250;

/**
 * Trust below which a candidate cannot be auto-selected regardless of agreement.
 *
 * Set just above `stated_landmark` (35). A geocoded landmark is a genuinely
 * useful lead and a poor basis for unattended dispatch — "Shiv Mandir" matches
 * thousands of places, and agreement among two weak guesses is not strength.
 */
const AUTO_SELECT_MIN_TRUST = 50;

export interface ResolveInput {
  /** Raw message text, searched for coordinates, Plus Codes and map links. */
  text?: string | null;
  /** What the extraction model reported was said about location. */
  stated?: StatedLocation | null;
  /** A device fix, when the channel supplied one. */
  device?: {
    latitude: number;
    longitude: number;
    accuracy_m: number | null;
    source: Extract<LocationSource, "device_els" | "device_gps" | "network_cell">;
    obtained_at: string;
  } | null;
  /** Address on file for this caller, already geocoded. */
  registered?: { latitude: number; longitude: number; label: string } | null;
  /** Existing candidates to merge with, from earlier messages on this incident. */
  existing?: LocationCandidate[];
  /** Timestamp for candidates produced now. Passed in so results are testable. */
  now: string;
}

export interface ResolveOutcome {
  location: ResolvedLocation;
  /** Why selection was withheld, when it was. Surfaced to the operator. */
  ambiguity: string | null;
  /** True when a human should adjudicate the location before dispatch. */
  needs_human: boolean;
}

export class LocationResolver {
  constructor(private readonly geocoder: GeocodeProvider) {}

  async resolve(input: ResolveInput): Promise<ResolveOutcome> {
    const candidates: LocationCandidate[] = [...(input.existing ?? [])];

    // 1. Device fixes. These never passed through the transcript, so they
    //    carry no recognition error and outrank everything the caller said.
    if (input.device) {
      candidates.push({
        source: input.device.source,
        point: { latitude: input.device.latitude, longitude: input.device.longitude },
        accuracy_m: input.device.accuracy_m,
        label: "Device location",
        trust: LOCATION_SOURCE_TRUST[input.device.source],
        obtained_at: input.device.obtained_at,
      });
    }

    // 2. Exact things written in the message. Offline, no API, no ambiguity.
    if (input.text) {
      const bias = input.device ?? input.registered ?? null;
      for (const found of extractLocations(input.text, bias)) {
        const source: LocationSource =
          found.kind === "plus_code" ? "plus_code" : "stated_address";

        candidates.push({
          source,
          point: { latitude: found.latitude, longitude: found.longitude },
          accuracy_m: found.accuracy_m,
          label: found.outside_service_area
            ? `${found.matched} (outside the service area)`
            : found.matched,
          // A point outside India is far more often a transposed pair than a
          // genuine foreign location. Demoted rather than dropped, so an
          // operator can still see and use it if it is real.
          trust: found.outside_service_area
            ? Math.floor(LOCATION_SOURCE_TRUST[source] / 2)
            : LOCATION_SOURCE_TRUST[source],
          obtained_at: input.now,
        });
      }
    }

    // 3. The landmark, geocoded. Weakest, and the most likely to be plural.
    const stated = input.stated ?? null;
    const queryText = stated?.landmark ?? stated?.street ?? stated?.raw ?? null;

    if (queryText) {
      const matches = await this.geocoder.search({
        text: queryText,
        near: stated?.locality ?? stated?.city ?? null,
        bias: input.device ?? input.registered ?? null,
        limit: 5,
      });

      for (const match of matches) {
        candidates.push({
          source: "stated_landmark",
          point: { latitude: match.latitude, longitude: match.longitude },
          accuracy_m: match.accuracy_m,
          label: match.label,
          // Provider confidence modulates trust within the landmark band but
          // never lifts a landmark above a device fix or a Plus Code. Ordering
          // across source kinds is a property of the source, not of how sure a
          // geocoder happens to sound.
          trust: Math.round(
            LOCATION_SOURCE_TRUST.stated_landmark * (0.5 + match.confidence / 2),
          ),
          obtained_at: input.now,
        });
      }
    }

    // 4. The caller's registered address. Weak — people call from elsewhere —
    //    but better than nothing when everything else is silent.
    if (input.registered) {
      candidates.push({
        source: "caller_registered",
        point: {
          latitude: input.registered.latitude,
          longitude: input.registered.longitude,
        },
        accuracy_m: null,
        label: input.registered.label,
        trust: LOCATION_SOURCE_TRUST.caller_registered,
        obtained_at: input.now,
      });
    }

    const ranked = rankCandidates(dedupe(candidates));
    const decision = decideSelection(ranked);

    return {
      location: {
        candidates: ranked,
        selected_index: decision.index,
        selected_by_human: false,
        stated,
      },
      ambiguity: decision.ambiguity,
      needs_human: decision.index === null && ranked.length > 0,
    };
  }
}

/* ------------------------------------------------------------------ *
 * Selection
 * ------------------------------------------------------------------ */

interface Selection {
  index: number | null;
  ambiguity: string | null;
}

/**
 * Decides whether the evidence supports selecting a location.
 *
 * Three outcomes, and the middle one is the point of the whole module:
 *
 *  - Nothing to select from — no candidates at all.
 *  - Candidates that disagree, or agree only weakly — left unselected, with a
 *    reason a call-taker can read.
 *  - A trustworthy candidate that nothing credible contradicts — selected.
 */
function decideSelection(ranked: LocationCandidate[]): Selection {
  if (ranked.length === 0) {
    return { index: null, ambiguity: null };
  }

  const best = ranked[0]!;

  if (best.trust < AUTO_SELECT_MIN_TRUST) {
    return {
      index: null,
      ambiguity:
        ranked.length > 1
          ? `${ranked.length} possible locations, none from a trusted source. Confirm with the caller.`
          : "Only a stated landmark is available. Confirm with the caller.",
    };
  }

  // A credible competitor that disagrees is a question, not a tie to break.
  const contradicting = ranked
    .slice(1)
    .filter(
      (candidate) =>
        candidate.trust >= AUTO_SELECT_MIN_TRUST &&
        distanceMetres(best.point, candidate.point) > AGREEMENT_RADIUS_M,
    );

  if (contradicting.length > 0) {
    const worst = contradicting.reduce((furthest, candidate) =>
      distanceMetres(best.point, candidate.point) >
      distanceMetres(best.point, furthest.point)
        ? candidate
        : furthest,
    );
    const km = (distanceMetres(best.point, worst.point) / 1000).toFixed(1);

    return {
      index: null,
      ambiguity:
        `Two trusted sources disagree by ${km} km ` +
        `(${best.label} vs ${worst.label}). Confirm before dispatch.`,
    };
  }

  return { index: 0, ambiguity: null };
}

/* ------------------------------------------------------------------ *
 * Geometry
 * ------------------------------------------------------------------ */

/**
 * Great-circle distance in metres.
 *
 * Note the name and the unit. The prototype computed kilometres with this
 * formula and rendered the number as "miles"; putting the unit in the
 * identifier is the cheapest available defence against repeating that.
 *
 * This is for comparing candidates, never for dispatch ranking — road distance
 * is what decides which unit goes.
 */
export function distanceMetres(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const EARTH_RADIUS_M = 6_371_000;
  const toRadians = (deg: number) => (deg * Math.PI) / 180;

  const dLat = toRadians(b.latitude - a.latitude);
  const dLon = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);

  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Collapses candidates from the same source that denote the same point. */
function dedupe(candidates: LocationCandidate[]): LocationCandidate[] {
  const kept: LocationCandidate[] = [];

  for (const candidate of candidates) {
    const duplicate = kept.find(
      (existing) =>
        existing.source === candidate.source &&
        distanceMetres(existing.point, candidate.point) < 25,
    );
    // Same source, same spot: keep the more recent, which may carry a better
    // accuracy figure. Different sources agreeing is evidence and is kept.
    if (!duplicate) {
      kept.push(candidate);
    } else if (Date.parse(candidate.obtained_at) > Date.parse(duplicate.obtained_at)) {
      kept[kept.indexOf(duplicate)] = candidate;
    }
  }

  return kept;
}
