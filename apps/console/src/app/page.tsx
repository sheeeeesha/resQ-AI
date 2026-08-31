"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  api,
  ApiError,
  clearToken,
  getToken,
  setToken,
  subscribeToIncidents,
  type IncidentDetail,
  type QueueIncident,
  type Segment,
  type UnitRecommendation,
} from "@/lib/api";
import { Queue } from "@/components/queue";
import { Fields } from "@/components/fields";
import { Location } from "@/components/location";
import { Units } from "@/components/units";
import { Transcript } from "@/components/transcript";
import { Escalation, Priority } from "@/components/primitives";

/**
 * The console.
 *
 * Three columns on a control-room monitor: queue, detail, transcript. Below
 * 1280px the transcript moves under the detail; below 900px the queue becomes
 * a drawer. Structural responsiveness only — nothing fluid-scales, because a
 * heading that resizes with its panel looks broken rather than responsive.
 */
export default function Console() {
  const [token, setLocalToken] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setLocalToken(getToken());
    setReady(true);
  }, []);

  if (!ready) return null;
  if (!token) return <SignIn onSignedIn={setLocalToken} />;

  return <Workspace onSignOut={() => setLocalToken(null)} />;
}

/* ------------------------------------------------------------------ *
 * Sign in
 * ------------------------------------------------------------------ */

function SignIn({ onSignedIn }: { onSignedIn: (token: string) => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  return (
    <main className="flex h-full items-center justify-center px-6">
      <form
        className="w-full max-w-sm"
        onSubmit={async (event) => {
          event.preventDefault();
          setToken(value.trim());
          try {
            // Verify against a real endpoint rather than accepting any string.
            // An operator who mistypes should find out now, not on the first
            // field they try to confirm during a live call.
            await api.queue();
            onSignedIn(value.trim());
          } catch (err) {
            clearToken();
            setError(
              err instanceof ApiError && err.isAuth
                ? "That token was not accepted."
                : "Could not reach the API. Is it running?",
            );
          }
        }}
      >
        <h1 className="text-xl font-semibold">ResQ AI</h1>
        <p className="mt-1 text-sm text-muted">Dispatch console</p>

        <label className="mt-6 block">
          <span className="text-xs text-faint">Operator token</span>
          <input
            type="password"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            autoFocus
            className="mt-1 w-full rounded border border-border bg-surface px-3 py-2 font-mono text-sm text-ink placeholder:text-faint"
            placeholder="Paste your token"
          />
        </label>

        {error && <p className="mt-2 text-sm text-danger">{error}</p>}

        <button
          type="submit"
          disabled={!value.trim()}
          className="mt-4 w-full rounded bg-accent px-4 py-2 text-sm font-medium text-accent-ink transition-colors hover:bg-accent-hover disabled:bg-raised disabled:text-faint"
        >
          Sign in
        </button>

        <p className="mt-4 text-xs text-faint">
          Interim authentication. Every confirmation and override is recorded
          against the operator this token identifies.
        </p>
      </form>
    </main>
  );
}

/* ------------------------------------------------------------------ *
 * Workspace
 * ------------------------------------------------------------------ */

function Workspace({ onSignOut }: { onSignOut: () => void }) {
  const [queue, setQueue] = useState<QueueIncident[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [incident, setIncident] = useState<IncidentDetail | null>(null);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [units, setUnits] = useState<UnitRecommendation | null>(null);

  const [loadingQueue, setLoadingQueue] = useState(true);
  const [loadingUnits, setLoadingUnits] = useState(false);
  const [busyField, setBusyField] = useState<string | null>(null);
  const [busyUnit, setBusyUnit] = useState<string | null>(null);
  const [busyLocation, setBusyLocation] = useState(false);

  const [live, setLive] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [arrivedIds, setArrivedIds] = useState<Set<string>>(new Set());

  // Read inside callbacks without making them depend on the value, so the
  // SSE subscription is not torn down and rebuilt on every selection change.
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selectedId;

  const loadQueue = useCallback(async () => {
    try {
      const { incidents } = await api.queue();
      setQueue(incidents);
    } catch (err) {
      if (err instanceof ApiError && err.isAuth) {
        clearToken();
        onSignOut();
      }
    } finally {
      setLoadingQueue(false);
    }
  }, [onSignOut]);

  const loadIncident = useCallback(async (id: string) => {
    const [detail, transcript] = await Promise.all([
      api.incident(id),
      api.transcript(id),
    ]);
    setIncident(detail.incident);
    setSegments(transcript.segments);

    setLoadingUnits(true);
    try {
      setUnits(await api.units(id));
    } catch {
      setUnits(null);
    } finally {
      setLoadingUnits(false);
    }
  }, []);

  useEffect(() => {
    void loadQueue();
  }, [loadQueue]);

  useEffect(() => {
    if (!selectedId) return;
    void loadIncident(selectedId);
  }, [selectedId, loadIncident]);

  /* ---- live updates ---- */

  useEffect(() => {
    const unsubscribe = subscribeToIncidents({
      onStatus: setLive,
      onIncident: (payload) => {
        void loadQueue();

        // Mark new arrivals so the queue row decays from a highlight. The one
        // attention-seeking movement in the interface, and it carries
        // information: a call-taker who glanced away sees something changed.
        if (payload.op === "INSERT") {
          setArrivedIds((current) => new Set(current).add(payload.incident_id));
          setTimeout(() => {
            setArrivedIds((current) => {
              const next = new Set(current);
              next.delete(payload.incident_id);
              return next;
            });
          }, 2500);
        }

        // Refresh the open incident when it is the one that changed — a new
        // message on this call should appear without the operator reloading.
        if (payload.incident_id === selectedRef.current) {
          void loadIncident(payload.incident_id);
        }
      },
    });

    return unsubscribe;
  }, [loadQueue, loadIncident]);

  /**
   * Polling backstop.
   *
   * The SSE stream is the primary channel and this is not a substitute for it.
   * It exists because a stream that dies silently looks exactly like a quiet
   * shift, and in this domain a missed incident is not an acceptable outcome
   * of a dropped TCP connection.
   */
  useEffect(() => {
    const timer = setInterval(() => void loadQueue(), live ? 60_000 : 10_000);
    return () => clearInterval(timer);
  }, [loadQueue, live]);

  /* ---- actions ---- */

  /**
   * Wraps an operator action with the two failures that matter.
   *
   * A version conflict is surfaced, never retried. Retrying with a fresh
   * version would silently overwrite whatever the other operator just decided,
   * which is precisely the class of bug the version check exists to prevent.
   */
  const act = useCallback(
    async (run: () => Promise<unknown>) => {
      if (!selectedRef.current) return;
      setNotice(null);

      try {
        await run();
        await Promise.all([loadIncident(selectedRef.current), loadQueue()]);
      } catch (err) {
        if (err instanceof ApiError && err.isConflict) {
          setNotice(
            "Someone else changed this incident while you were working. Reloaded — check the current values before retrying.",
          );
          await loadIncident(selectedRef.current);
        } else if (err instanceof ApiError) {
          setNotice(err.message);
        } else {
          setNotice("That did not go through. Check the connection and try again.");
        }
      }
    },
    [loadIncident, loadQueue],
  );

  const canDispatch = incident?.location.selected_index !== null;

  return (
    <main className="grid h-full grid-cols-1 lg:grid-cols-[380px_1fr] xl:grid-cols-[380px_1fr_420px]">
      <div className="hidden lg:block">
        <Queue
          incidents={queue}
          selectedId={selectedId}
          onSelect={setSelectedId}
          loading={loadingQueue}
          arrivedIds={arrivedIds}
          live={live}
        />
      </div>

      <div className="flex h-full flex-col overflow-hidden">
        {!incident ? (
          <div className="flex h-full items-center justify-center px-6">
            <div className="max-w-sm text-center">
              <p className="text-sm text-muted">Select an incident.</p>
              <p className="mt-1 text-xs text-faint">
                Everything the model proposed is shown with its confidence and
                the transcript it came from. Nothing is dispatched until you
                confirm it.
              </p>
            </div>
          </div>
        ) : (
          <>
            <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-border px-4 py-3">
              <Priority value={incident.priority} size="lg" />
              <span className="font-mono text-xl">{incident.reference}</span>
              <span className="text-sm text-muted">
                {incident.incident_type?.replace(/_/g, " ") ?? "unclassified"}
              </span>
              <span className="ml-auto flex items-center gap-3 text-xs text-faint">
                <span className="font-mono">{incident.channel}</span>
                <span className="font-mono">v{incident.version}</span>
                <button
                  type="button"
                  onClick={() => {
                    clearToken();
                    onSignOut();
                  }}
                  className="text-faint underline-offset-2 hover:text-muted hover:underline"
                >
                  Sign out
                </button>
              </span>
            </header>

            <Escalation triggers={incident.escalation_triggers} />

            {notice && (
              <p
                role="alert"
                className="border-b border-warn/30 bg-warn/8 px-4 py-2 text-sm text-warn"
              >
                {notice}
              </p>
            )}

            <div className="flex-1 overflow-y-auto">
              {incident.summary && (
                <p className="border-b border-border px-4 py-3 text-sm text-ink">
                  {incident.summary}
                </p>
              )}

              <Fields
                incident={incident}
                busy={busyField}
                onEvidenceSelect={setHighlighted}
                onConfirm={(field) =>
                  void act(async () => {
                    setBusyField(field);
                    try {
                      await api.confirmField(incident.incident_id, field, incident.version);
                    } finally {
                      setBusyField(null);
                    }
                  })
                }
                onOverride={(field, value, reason) =>
                  void act(async () => {
                    setBusyField(field);
                    try {
                      await api.overrideField(
                        incident.incident_id,
                        field,
                        incident.version,
                        value,
                        reason,
                      );
                    } finally {
                      setBusyField(null);
                    }
                  })
                }
              />

              <Location
                incident={incident}
                units={units?.units ?? []}
                busy={busyLocation}
                onSelect={(index) =>
                  void act(async () => {
                    setBusyLocation(true);
                    try {
                      await api.selectLocation(
                        incident.incident_id,
                        incident.version,
                        index,
                      );
                    } finally {
                      setBusyLocation(false);
                    }
                  })
                }
              />

              <Units
                recommendation={units}
                loading={loadingUnits}
                busy={busyUnit}
                canDispatch={canDispatch}
                onDispatch={(unitId) =>
                  void act(async () => {
                    setBusyUnit(unitId);
                    try {
                      await api.dispatchUnit(
                        incident.incident_id,
                        incident.version,
                        unitId,
                      );
                    } finally {
                      setBusyUnit(null);
                    }
                  })
                }
              />

              {/* The transcript lives here below 1280px, where the third
                  column is not available. */}
              <div className="xl:hidden">
                <Transcript segments={segments} highlighted={highlighted} />
              </div>
            </div>
          </>
        )}
      </div>

      <div className="hidden xl:block">
        <Transcript segments={segments} highlighted={highlighted} />
      </div>
    </main>
  );
}
