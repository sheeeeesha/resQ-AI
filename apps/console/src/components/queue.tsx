"use client";

import { Priority, SkeletonRows } from "./primitives";
import type { QueueIncident } from "@/lib/api";

/**
 * The dispatch queue.
 *
 * A table, not cards. Cards cost vertical space a call-taker pays for in
 * scrolling, and scrolling costs seconds of someone's emergency. Density is the
 * correct answer here.
 *
 * Sorted by priority ascending, because P0 is the most urgent — the same order
 * the API returns, so the console never disagrees with the server about what is
 * most urgent.
 */

const CHANNEL_GLYPH: Record<string, string> = {
  whatsapp: "WA",
  sms: "SMS",
  web: "WEB",
  voice: "TEL",
  ivr: "IVR",
  app: "APP",
};

export function Queue({
  incidents,
  selectedId,
  onSelect,
  loading,
  arrivedIds,
  live,
}: {
  incidents: QueueIncident[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  loading: boolean;
  arrivedIds: Set<string>;
  live: boolean;
}) {
  return (
    <div className="flex h-full flex-col border-r border-border bg-surface">
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <h1 className="text-lg font-semibold">Queue</h1>
        <div className="flex items-center gap-3">
          <span className="font-mono text-sm text-faint">{incidents.length}</span>
          {/*
            Connection state, always visible. A dead stream looks exactly like
            a quiet shift, which is the worst way for this to fail — so the
            console says which one it is rather than leaving it ambiguous.
          */}
          <span
            className="flex items-center gap-1.5 text-xs"
            title={live ? "Receiving live updates" : "Live updates lost — reconnecting"}
          >
            <span
              aria-hidden
              className={`h-1.5 w-1.5 rounded-full ${live ? "bg-ok" : "bg-warn"}`}
            />
            <span className={live ? "text-faint" : "text-warn"}>
              {live ? "live" : "reconnecting"}
            </span>
          </span>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto">
        {loading && incidents.length === 0 ? (
          <SkeletonRows rows={8} />
        ) : incidents.length === 0 ? (
          <div className="px-4 py-6">
            <p className="text-sm text-muted">Nothing in the queue.</p>
            <p className="mt-1 text-xs text-faint">
              Incidents appear here the moment one arrives on any channel.
            </p>
          </div>
        ) : (
          <ul>
            {incidents.map((incident) => (
              <QueueRow
                key={incident.incident_id}
                incident={incident}
                selected={incident.incident_id === selectedId}
                arrived={arrivedIds.has(incident.incident_id)}
                onSelect={onSelect}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function QueueRow({
  incident,
  selected,
  arrived,
  onSelect,
}: {
  incident: QueueIncident;
  selected: boolean;
  arrived: boolean;
  onSelect: (id: string) => void;
}) {
  const escalated = incident.escalation_triggers.length > 0;
  const lifeThreat = incident.escalation_triggers.includes("life_threat_indicated");

  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(incident.incident_id)}
        aria-current={selected ? "true" : undefined}
        className={`w-full border-b border-border/60 px-4 py-2.5 text-left transition-colors duration-150 ${
          selected ? "bg-accent-muted" : "hover:bg-raised"
        } ${arrived ? "animate-arrive" : ""}`}
      >
        <div className="flex items-baseline gap-2">
          <Priority value={incident.priority} />
          <span className="truncate font-mono text-xs text-faint">
            {incident.reference}
          </span>
          <span className="ml-auto shrink-0 font-mono text-xs text-faint">
            {CHANNEL_GLYPH[incident.channel] ?? incident.channel.toUpperCase()}
          </span>
        </div>

        <p className="mt-1 line-clamp-2 text-sm text-ink">
          {incident.incident_type
            ? incident.incident_type.replace(/_/g, " ")
            : /* Never an empty cell: a blank looks like a rendering bug. */
              "unclassified"}
        </p>

        {incident.summary && (
          <p className="mt-0.5 line-clamp-1 text-xs text-faint">{incident.summary}</p>
        )}

        {/*
          Status markers, each with a word rather than a bare colour. These are
          the three questions a call-taker asks scanning the queue: does this
          need me, can it be dispatched, and was the machine impaired.
        */}
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs">
          {escalated && (
            <span className={lifeThreat ? "text-danger" : "text-warn"}>
              {lifeThreat ? "▲ life threat" : "▲ escalated"}
            </span>
          )}
          {!incident.location_confirmed && (
            <span className="text-warn" title={incident.location_ambiguity ?? undefined}>
              ◎ location unconfirmed
            </span>
          )}
          {incident.degraded_mode && (
            <span className="text-warn" title="Classified in degraded mode">
              ◇ degraded
            </span>
          )}
        </div>
      </button>
    </li>
  );
}
