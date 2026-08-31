"use client";

import dynamic from "next/dynamic";
import { Empty, Panel } from "./primitives";
import type { IncidentDetail, LocationCandidate, RecommendedUnit } from "@/lib/api";

/**
 * Leaflet touches `window` at module scope, so it cannot be server-rendered.
 *
 * The placeholder is a sized block rather than a spinner: the map occupies a
 * fixed slot in the panel, and collapsing it while loading would shift every
 * control underneath it just as an operator reaches for one.
 */
const IncidentMap = dynamic(() => import("./map"), {
  ssr: false,
  loading: () => (
    <div className="h-72 animate-pulse border-b border-border bg-raised/40" />
  ),
});

/**
 * Location candidates.
 *
 * Every candidate is shown with where it came from, never collapsed to one
 * answer. The prototype geocoded a model-produced address and took
 * `results[0]`, which on an Indian address is a coin flip presented as a fact —
 * "Shiv Mandir" matches thousands of places and "Gandhi Road" exists in most
 * cities in the country.
 *
 * So when the system cannot choose, it says so here and a person chooses. That
 * choice is what unlocks dispatch.
 */

const SOURCE_LABEL: Record<string, string> = {
  device_els: "Device (emergency location)",
  device_gps: "Device GPS",
  network_cell: "Cell tower",
  plus_code: "Plus Code",
  what3words: "what3words",
  stated_address: "Stated coordinates",
  stated_landmark: "Stated landmark",
  caller_registered: "Registered address",
  inferred: "Inferred",
};

/** Sources that did not pass through a transcript, and so carry no ASR error. */
const DEVICE_SOURCES = new Set(["device_els", "device_gps", "network_cell"]);

export function Location({
  incident,
  units,
  busy,
  onSelect,
}: {
  incident: IncidentDetail;
  /** Plotted alongside the incident so distance is visible, not just listed. */
  units: RecommendedUnit[];
  busy: boolean;
  onSelect: (index: number) => void;
}) {
  const { candidates, selected_index, selected_by_human, stated } = incident.location;

  return (
    <Panel
      title="Location"
      action={
        selected_index === null ? (
          <span className="text-xs text-warn">unconfirmed</span>
        ) : (
          <span className="text-xs text-ok">
            {selected_by_human ? "confirmed by operator" : "confirmed"}
          </span>
        )
      }
    >
      {/*
        What the caller actually said, kept verbatim and in the original script.
        A dispatcher recognises the original string; a translation of it is
        useless to them.
      */}
      {stated?.raw && (
        <p className="px-4 pb-2 text-sm text-muted">
          <span className="text-xs text-faint">Caller said: </span>
          {stated.raw}
        </p>
      )}

      {incident.location_ambiguity && (
        <p className="mx-4 mb-2 rounded border border-warn/30 bg-warn/8 px-3 py-2 text-xs text-warn">
          {incident.location_ambiguity}
        </p>
      )}

      {candidates.length === 0 ? (
        <Empty>
          No location yet. Ask the caller for a landmark, a Plus Code, or to
          share their location.
        </Empty>
      ) : (
        <>
          <IncidentMap
            candidates={candidates}
            selectedIndex={selected_index}
            units={units}
            onSelectCandidate={onSelect}
            busy={busy}
          />

          {/*
            The list stays. The map answers "where", the list answers "from
            what source, and how sure" — and the second question is the one
            that decides whether a candidate is trustworthy. A pin cannot say
            "geocoded landmark, ±500 m" the way a row can.
          */}
          <ul className="pb-2">
            {candidates.map((candidate, index) => (
              <CandidateRow
              key={`${candidate.source}-${index}`}
              candidate={candidate}
              index={index}
              selected={index === selected_index}
              confirmedByHuman={selected_by_human}
              busy={busy}
              onSelect={onSelect}
            />
            ))}
          </ul>
        </>
      )}
    </Panel>
  );
}

function CandidateRow({
  candidate,
  index,
  selected,
  confirmedByHuman,
  busy,
  onSelect,
}: {
  candidate: LocationCandidate;
  index: number;
  selected: boolean;
  confirmedByHuman: boolean;
  busy: boolean;
  onSelect: (index: number) => void;
}) {
  const fromDevice = DEVICE_SOURCES.has(candidate.source);

  return (
    <li
      className={`flex items-start gap-3 px-4 py-2 ${
        selected ? "bg-accent-muted/50" : ""
      }`}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-sm text-ink">{candidate.label}</span>
          {selected && (
            <span className="text-xs text-ok">
              {confirmedByHuman ? "✓ selected" : "✓ auto"}
            </span>
          )}
        </div>

        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs text-faint">
          <span className={fromDevice ? "text-ok" : undefined}>
            {SOURCE_LABEL[candidate.source] ?? candidate.source}
          </span>

          {/* Coordinates in mono: an operator reads these aloud over radio. */}
          <span className="font-mono">
            {candidate.point.latitude.toFixed(5)},{" "}
            {candidate.point.longitude.toFixed(5)}
          </span>

          {candidate.accuracy_m !== null && (
            <span title="Radius of uncertainty">±{candidate.accuracy_m} m</span>
          )}
        </div>
      </div>

      {!selected && (
        <button
          type="button"
          onClick={() => onSelect(index)}
          disabled={busy}
          className="shrink-0 rounded border border-border px-2 py-0.5 text-xs text-muted transition-colors hover:border-accent hover:text-accent disabled:opacity-40"
        >
          Use this
        </button>
      )}
    </li>
  );
}
