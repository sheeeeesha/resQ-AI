"use client";

import { useEffect, useMemo } from "react";
import {
  Circle,
  CircleMarker,
  MapContainer,
  Marker,
  Polyline,
  TileLayer,
  Tooltip,
  useMap,
} from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";

import type { LocationCandidate, RecommendedUnit } from "@/lib/api";

/**
 * The incident map.
 *
 * This is the one place in the console where the visual channel does real
 * work rather than decoration. An operator resolving two "Shiv Mandir"
 * candidates 12 km apart is doing a spatial comparison, and reading
 * `17.36160, 78.47470` against `17.43990, 78.49830` is precisely the
 * comparison humans are worst at.
 *
 * Two things it shows that the list cannot:
 *
 *  - **How far apart the candidates actually are.** The ambiguity warning says
 *    "12 km"; the map shows which side of the city.
 *  - **Where the units are relative to the incident.** A four-minute unit
 *    across a river is not a four-minute unit, and the list has no way to
 *    suggest that.
 */

/*
 * Standard OpenStreetMap tiles, darkened in CSS.
 *
 * The obvious choice was CARTO's dark basemap, and it turned out to serve
 * tiles stamped "API KEY REQUIRED" — they render, so nothing errors, and the
 * watermark only shows up when you actually look at the map. Exactly the kind
 * of failure that reaches a demonstration intact.
 *
 * OSM's own tiles need no key and carry no watermark, but they are light: a
 * bright rectangle in a console built for a dim room reintroduces the glare
 * the dark theme exists to avoid, at the moment an operator is looking most
 * closely. So they are inverted and hue-corrected in CSS (see `globals.css`),
 * which costs nothing and depends on no one's pricing decisions.
 *
 * Note that tiles come from a third party either way, which means the tile
 * server learns roughly where each emergency is. Fine for a demonstration; for
 * a real deployment this is the same data-processor question the geocoder
 * raised, and self-hosted tiles answer it without a code change.
 */
const TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

/** Sources that never passed through a transcript, and so carry no ASR error. */
const DEVICE_SOURCES = new Set(["device_els", "device_gps", "network_cell"]);

/**
 * Marker colours follow the console's rule: saturated hue means a status
 * value. Selection is violet because violet is interaction, never data.
 */
const COLOUR = {
  selected: "oklch(0.62 0.19 295)",
  device: "oklch(0.72 0.16 150)",
  candidate: "oklch(0.78 0.15 75)",
  ambulance: "oklch(0.72 0.16 150)",
  police: "oklch(0.70 0.12 240)",
  fire: "oklch(0.64 0.23 25)",
  other: "oklch(0.62 0.03 265)",
};

function unitColour(kind: string): string {
  if (kind.startsWith("ambulance") || kind === "hospital") return COLOUR.ambulance;
  if (kind.startsWith("police")) return COLOUR.police;
  if (kind.startsWith("fire")) return COLOUR.fire;
  return COLOUR.other;
}

/** A numbered pin, so a candidate on the map maps onto its row in the list. */
function candidateIcon(index: number, selected: boolean): L.DivIcon {
  const colour = selected ? COLOUR.selected : COLOUR.candidate;
  return L.divIcon({
    className: "",
    html: `<div style="
      width:22px;height:22px;border-radius:50% 50% 50% 0;
      transform:rotate(-45deg);
      background:${colour};
      border:2px solid oklch(0.17 0.012 265);
      box-shadow:0 1px 4px rgba(0,0,0,0.6);
      display:grid;place-items:center;
    "><span style="
      transform:rotate(45deg);
      font:600 11px/1 ui-sans-serif,system-ui;
      color:oklch(0.17 0.012 265);
    ">${index + 1}</span></div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 22],
  });
}

/** Keeps the viewport around everything worth seeing as the data changes. */
function FitBounds({ points }: { points: Array<[number, number]> }) {
  const map = useMap();

  useEffect(() => {
    if (points.length === 0) return;

    if (points.length === 1) {
      map.setView(points[0]!, 15);
      return;
    }

    // The floor is set on the map itself rather than here — fitBounds has no
    // minZoom option, and constraining the map constrains every fit it does.
    map.fitBounds(L.latLngBounds(points), { padding: [40, 40], maxZoom: 16 });
  }, [map, points]);

  return null;
}

export interface IncidentMapProps {
  candidates: LocationCandidate[];
  selectedIndex: number | null;
  units: RecommendedUnit[];
  onSelectCandidate: (index: number) => void;
  busy: boolean;
}

export default function IncidentMap({
  candidates,
  selectedIndex,
  units,
  onSelectCandidate,
  busy,
}: IncidentMapProps) {
  const selected =
    selectedIndex === null ? null : (candidates[selectedIndex] ?? null);

  /*
   * What the viewport fits.
   *
   * Every candidate, always — resolving which of them is right is the job the
   * map exists for, and a candidate outside the view cannot be compared.
   *
   * Units, only the nearest few. Fitting all of them zooms out to include a
   * tender 13 km away, and at that zoom the streets around the incident stop
   * being legible — losing the detail an operator uses to judge a candidate in
   * order to show a unit whose distance the list already states precisely.
   */
  const points = useMemo<Array<[number, number]>>(() => {
    const candidatePoints = candidates.map(
      (c) => [c.point.latitude, c.point.longitude] as [number, number],
    );

    const nearestUnits = [...units]
      .sort((a, b) => a.straight_line_m - b.straight_line_m)
      .slice(0, 3)
      .map((u) => [u.point.latitude, u.point.longitude] as [number, number]);

    return [...candidatePoints, ...nearestUnits];
  }, [candidates, units]);

  if (candidates.length === 0) {
    return (
      <div className="flex h-64 items-center justify-center border-b border-border bg-surface px-4">
        <p className="text-sm text-faint">
          No location to plot yet. Ask the caller for a landmark, a Plus Code,
          or to share their location.
        </p>
      </div>
    );
  }

  return (
    <div className="relative h-72 border-b border-border">
      <MapContainer
        center={[candidates[0]!.point.latitude, candidates[0]!.point.longitude]}
        zoom={14}
        // Below roughly this zoom the street network stops rendering names,
        // and a map without street names cannot answer the question an
        // operator is asking it. Constrains fitBounds as well as the controls.
        minZoom={12}
        // Scroll-wheel zoom is off: an operator scrolling the incident panel
        // should not have the map swallow the gesture and zoom instead.
        scrollWheelZoom={false}
        className="h-full w-full bg-bg"
        attributionControl
      >
        <TileLayer url={TILE_URL} attribution={TILE_ATTRIBUTION} maxZoom={19} />
        <FitBounds points={points} />

        {/*
          A line between the chosen location and each unit. Not a route — a
          straight line, drawn faintly, purely to make the spatial relationship
          legible. Drawing it as a route would imply a road path nobody computed.
        */}
        {selected &&
          units.map((unit) => (
            <Polyline
              key={`line-${unit.unit_id}`}
              positions={[
                [selected.point.latitude, selected.point.longitude],
                [unit.point.latitude, unit.point.longitude],
              ]}
              pathOptions={{
                color: unitColour(unit.kind),
                weight: 1,
                opacity: 0.28,
                dashArray: "3 5",
              }}
            />
          ))}

        {/* Units, drawn under the candidates so the incident stays on top. */}
        {units.map((unit) => (
          <CircleMarker
            key={unit.unit_id}
            center={[unit.point.latitude, unit.point.longitude]}
            radius={5}
            pathOptions={{
              color: "oklch(0.17 0.012 265)",
              weight: 2,
              fillColor: unitColour(unit.kind),
              fillOpacity: unit.availability === "available" ? 0.95 : 0.4,
            }}
          >
            <Tooltip direction="top" offset={[0, -6]}>
              <span className="font-medium">{unit.name}</span>
              {unit.travel_time_s !== null && (
                <>
                  {" · "}
                  {Math.max(1, Math.round(unit.travel_time_s / 60))} min
                  {unit.is_fallback_estimate && " est."}
                </>
              )}
            </Tooltip>
          </CircleMarker>
        ))}

        {candidates.map((candidate, index) => {
          const isSelected = index === selectedIndex;

          return (
            <div key={`${candidate.source}-${index}`}>
              {/*
                The uncertainty radius, drawn to scale. A device fix at 30 m and
                a geocoded landmark at 500 m look identical in a list; here the
                difference is the thing you notice first, which is the right
                thing to notice.
              */}
              {candidate.accuracy_m !== null && candidate.accuracy_m > 0 && (
                <Circle
                  center={[candidate.point.latitude, candidate.point.longitude]}
                  radius={candidate.accuracy_m}
                  pathOptions={{
                    color: isSelected ? COLOUR.selected : COLOUR.candidate,
                    weight: 1,
                    opacity: 0.5,
                    fillOpacity: 0.08,
                  }}
                />
              )}

              <Marker
                position={[candidate.point.latitude, candidate.point.longitude]}
                icon={candidateIcon(index, isSelected)}
                eventHandlers={{
                  click: () => {
                    if (!busy && !isSelected) onSelectCandidate(index);
                  },
                }}
              >
                <Tooltip direction="top" offset={[0, -20]}>
                  <span className="font-medium">{candidate.label}</span>
                  <br />
                  {DEVICE_SOURCES.has(candidate.source)
                    ? "From the device"
                    : candidate.source.replace(/_/g, " ")}
                  {candidate.accuracy_m !== null && ` · ±${candidate.accuracy_m} m`}
                  <br />
                  {isSelected ? (
                    <span>in use</span>
                  ) : (
                    <span>click to use this location</span>
                  )}
                </Tooltip>
              </Marker>
            </div>
          );
        })}
      </MapContainer>

      {/*
        An unconfirmed location is stated over the map as well as beside it.
        The map is the most convincing thing on the screen, and a convincing
        picture of a location nobody has verified is exactly the impression
        this system must not give.
      */}
      {selectedIndex === null && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-[400] bg-warn/12 px-3 py-1.5 text-center text-xs text-warn backdrop-blur-[2px]">
          {candidates.length} possible locations · none confirmed
        </div>
      )}
    </div>
  );
}
