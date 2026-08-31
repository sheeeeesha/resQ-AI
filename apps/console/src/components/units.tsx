"use client";

import { Empty, Panel } from "./primitives";
import type { UnitRecommendation, RecommendedUnit } from "@/lib/api";

/**
 * Unit recommendations.
 *
 * Recommendations, never dispatches. The system produces a ranked list; a
 * person sends a vehicle. Nothing in this console can move a unit without an
 * operator pressing the button, and the button records who pressed it.
 *
 * Two things are shown that most dispatch interfaces hide, and both matter
 * more than the ranking itself:
 *
 *  - Whether a travel time was **routed or estimated**. An unlabelled fallback
 *    estimate is indistinguishable from a real one at exactly the moment it
 *    matters.
 *  - Why there is nothing to show. "We do not know where this is" and "no
 *    ambulance is free" are different answers needing different next actions,
 *    and an empty list alone cannot tell them apart.
 */

const KIND_LABEL: Record<string, string> = {
  ambulance: "Ambulance",
  police_vehicle: "Police",
  fire_tender: "Fire tender",
  rescue_team: "Rescue",
  hospital: "Hospital",
  police_station: "Police station",
  fire_station: "Fire station",
  other: "Unit",
};

export function Units({
  recommendation,
  loading,
  busy,
  canDispatch,
  onDispatch,
}: {
  recommendation: UnitRecommendation | null;
  loading: boolean;
  busy: string | null;
  canDispatch: boolean;
  onDispatch: (unitId: string) => void;
}) {
  return (
    <Panel
      title="Response units"
      action={
        recommendation?.degraded_routing ? (
          <span
            className="text-xs text-warn"
            title="No routing engine reachable; times are straight-line estimates"
          >
            estimated times
          </span>
        ) : null
      }
    >
      {loading ? (
        <Empty>Finding units…</Empty>
      ) : !recommendation || recommendation.units.length === 0 ? (
        <Empty>
          {recommendation?.blocked_reason ??
            "No recommendation available for this incident."}
        </Empty>
      ) : (
        <>
          {recommendation.blocked_reason && (
            <p className="mx-4 mb-2 rounded border border-warn/30 bg-warn/8 px-3 py-2 text-xs text-warn">
              {recommendation.blocked_reason}
            </p>
          )}
          <ul className="pb-2">
            {recommendation.units.map((unit) => (
              <UnitRow
                key={unit.unit_id}
                unit={unit}
                busy={busy === unit.unit_id}
                canDispatch={canDispatch}
                onDispatch={onDispatch}
              />
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
}

function UnitRow({
  unit,
  busy,
  canDispatch,
  onDispatch,
}: {
  unit: RecommendedUnit;
  busy: boolean;
  canDispatch: boolean;
  onDispatch: (unitId: string) => void;
}) {
  const committed = unit.availability !== "available";

  return (
    <li className="flex items-center gap-3 px-4 py-2">
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-sm text-ink">{unit.name}</span>
          <span className="font-mono text-xs text-faint">{unit.unit_id}</span>
          {committed && (
            <span className="text-xs text-warn" title="Committed to another incident">
              {unit.availability.replace(/_/g, " ")}
            </span>
          )}
        </div>

        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs text-faint">
          <span>{KIND_LABEL[unit.kind] ?? unit.kind}</span>

          {/*
            Travel time leads, because that is the question. Distance is the
            supporting figure — in an Indian city the nearest unit by straight
            line is routinely the slowest to arrive.
          */}
          {unit.travel_time_s !== null && (
            <span className={unit.is_fallback_estimate ? "text-warn" : "text-ok"}>
              {formatDuration(unit.travel_time_s)}
              {unit.is_fallback_estimate && (
                <span title="Straight-line estimate, not a routed time"> est.</span>
              )}
            </span>
          )}

          <span>{formatDistance(unit.road_distance_m ?? unit.straight_line_m)}</span>

          {unit.contact_number && (
            <span className="font-mono">{unit.contact_number}</span>
          )}
        </div>
      </div>

      <button
        type="button"
        onClick={() => onDispatch(unit.unit_id)}
        disabled={busy || !canDispatch}
        title={
          canDispatch
            ? `Dispatch ${unit.name}`
            : "Confirm the incident location before dispatching"
        }
        className="shrink-0 rounded bg-accent px-3 py-1 text-xs font-medium text-accent-ink transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:bg-raised disabled:text-faint"
      >
        {busy ? "…" : "Dispatch"}
      </button>
    </li>
  );
}

/** Minutes, because a call-taker thinks in minutes and never in 847 seconds. */
function formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return "<1 min";
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** The unit is always in the string. The prototype rendered km as "miles". */
function formatDistance(metres: number): string {
  return metres < 1000
    ? `${Math.round(metres)} m`
    : `${(metres / 1000).toFixed(1)} km`;
}
