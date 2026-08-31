"use client";

import { useEffect, useRef } from "react";
import type { Segment } from "@/lib/api";

/**
 * The transcript.
 *
 * Shows the original text, in the original script, always. The English
 * rendering sits underneath as a secondary line when one exists.
 *
 * That ordering is the point. The extraction model reads the original, and a
 * call-taker checking the machine's work needs to see what the model saw.
 * Leading with a translation would also lose the exact place names a local
 * dispatcher recognises — "Shiv Mandir ke peeche" does not survive becoming
 * "behind the Shiva temple".
 */

const SPEAKER_LABEL: Record<string, string> = {
  caller: "Caller",
  call_taker: "Call-taker",
  ai_agent: "System",
  unknown: "Unknown",
};

export function Transcript({
  segments,
  highlighted,
}: {
  segments: Segment[];
  highlighted: string | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Scroll a cited segment into view when an operator clicks its evidence chip.
  useEffect(() => {
    if (!highlighted) return;
    const element = containerRef.current?.querySelector(`[data-segment="${highlighted}"]`);
    element?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [highlighted]);

  return (
    <div className="flex h-full flex-col border-l border-border bg-surface">
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-faint">
          Transcript
        </h2>
        <span className="font-mono text-xs text-faint">{segments.length}</span>
      </header>

      <div ref={containerRef} className="flex-1 overflow-y-auto px-4 py-3">
        {segments.length === 0 ? (
          <p className="text-sm text-faint">Nothing received yet.</p>
        ) : (
          <ol className="space-y-3">
            {segments.map((segment) => {
              const id = `s${segment.idx}`;
              const isHighlighted = highlighted === id;

              return (
                <li
                  key={segment.idx}
                  data-segment={id}
                  className={`rounded px-2 py-1.5 transition-colors duration-200 ${
                    isHighlighted ? "bg-accent-muted" : ""
                  }`}
                >
                  <div className="flex items-baseline gap-2 text-xs text-faint">
                    <span className="font-mono">{id}</span>
                    <span>{SPEAKER_LABEL[segment.speaker] ?? segment.speaker}</span>
                    <span className="font-mono">{segment.language}</span>

                    {/*
                      Only meaningful on voice. Text channels have no
                      recognition step, so there is no confidence to report and
                      the field is null rather than zero.
                    */}
                    {segment.asr_confidence !== null && (
                      <span
                        className={segment.asr_confidence < 0.7 ? "text-warn" : undefined}
                        title="Recognition confidence"
                      >
                        {Math.round(segment.asr_confidence * 100)}%
                      </span>
                    )}

                    <time className="ml-auto" dateTime={segment.received_at}>
                      {new Date(segment.received_at).toLocaleTimeString("en-IN", {
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                      })}
                    </time>
                  </div>

                  {/* The original, always primary. */}
                  <p className="mt-0.5 text-sm text-ink">{segment.text}</p>

                  {segment.text_en && segment.text_en !== segment.text && (
                    <p className="mt-0.5 text-xs italic text-faint">{segment.text_en}</p>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </div>
  );
}
