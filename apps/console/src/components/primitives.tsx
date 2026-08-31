import type { ReactNode } from "react";
import type { ReviewedField } from "@/lib/api";

/**
 * Shared display primitives.
 *
 * Two rules run through all of them, and both come from the domain rather than
 * from taste:
 *
 *  1. No status is ever carried by colour alone. Around 8% of men have a
 *     colour vision deficiency, and this is a public-service tool.
 *  2. An absent value always says why it is absent. A blank cell looks like a
 *     rendering bug; "not stated" is information.
 */

/* ------------------------------------------------------------------ *
 * Priority
 * ------------------------------------------------------------------ */

const PRIORITY_STYLE: Record<string, { color: string; label: string }> = {
  P0_immediate: { color: "text-p0 border-p0", label: "Immediate" },
  P1_urgent: { color: "text-p1 border-p1", label: "Urgent" },
  P2_prompt: { color: "text-p2 border-p2", label: "Prompt" },
  P3_routine: { color: "text-p3 border-p3", label: "Routine" },
  P4_referral: { color: "text-p4 border-p4", label: "Referral" },
};

/**
 * The priority badge.
 *
 * The code is the primary channel and always rendered; colour is the third,
 * after code and queue position. A call-taker reading `P0` does not depend on
 * seeing red to know what it means.
 */
export function Priority({
  value,
  size = "sm",
}: {
  value: string | null;
  size?: "sm" | "lg";
}) {
  if (!value) {
    return (
      <span className="font-mono text-xs italic text-faint" title="Not yet classified">
        —
      </span>
    );
  }

  const style = PRIORITY_STYLE[value] ?? { color: "text-faint border-border", label: value };
  const code = value.split("_")[0];

  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded border ${style.color} ${
        size === "lg" ? "px-2 py-0.5 text-sm" : "px-1.5 text-xs"
      } font-mono font-semibold`}
      title={style.label}
    >
      {code}
      {size === "lg" && (
        <span className="font-sans font-normal opacity-80">{style.label}</span>
      )}
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * Provenance
 * ------------------------------------------------------------------ */

/**
 * Renders a field's value with its provenance made visible.
 *
 * This is the component the console exists for. An AI proposal and a human
 * decision must never be confusable, and the distinction cannot be carried by
 * colour because colour is already carrying priority. So it is carried by
 * texture and weight:
 *
 *   ai_proposed     dashed underline, muted text — looks provisional
 *   human_confirmed solid ink, check glyph      — looks settled
 *   human_corrected as confirmed, plus the superseded value struck through
 *
 * That survives colour vision deficiency and a monochrome printout of a
 * handoff sheet, both of which are real for this user.
 */
export function FieldValue({ field }: { field: ReviewedField }) {
  const state = field.review?.state ?? "ai_proposed";

  if (field.status !== "extracted" || field.value === null) {
    return (
      <span className="text-xs italic text-faint">
        {field.status === "unclear" ? "unclear" : "not stated"}
      </span>
    );
  }

  const rendered = renderValue(field.value);

  if (state === "ai_proposed") {
    return (
      <span
        className="decoration-dotted underline decoration-faint underline-offset-4 text-muted"
        title="Proposed by the model. Not yet reviewed."
      >
        {rendered}
      </span>
    );
  }

  return (
    <span className="inline-flex items-baseline gap-1.5">
      <span
        className="text-ink"
        title={
          field.review.reviewed_by
            ? `Confirmed by ${field.review.reviewed_by}`
            : "Confirmed"
        }
      >
        {rendered}
      </span>
      <span aria-label="confirmed" className="text-ok text-xs">
        ✓
      </span>
      {state === "human_corrected" && field.review.superseded_value != null && (
        <span
          className="text-xs text-faint line-through"
          title="What the model had proposed"
        >
          {renderValue(field.review.superseded_value)}
        </span>
      )}
    </span>
  );
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (Array.isArray(value)) return value.map(renderValue).join(", ");
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    // People counts read as a range rather than as JSON.
    if ("min" in object && "max" in object) {
      return object.min === object.max
        ? String(object.min)
        : `${object.min}–${object.max}`;
    }
    return Object.entries(object)
      .filter(([, v]) => v !== null && v !== "")
      .map(([k, v]) => `${k.replace(/_/g, " ")}: ${String(v)}`)
      .join(" · ");
  }
  return String(value).replace(/_/g, " ");
}

/* ------------------------------------------------------------------ *
 * Confidence
 * ------------------------------------------------------------------ */

/**
 * Confidence as a number and a bar.
 *
 * Numeric because "0.62" is checkable and a bar alone is not, and because an
 * operator deciding whether to trust a classification needs the actual figure.
 * The bar is the fast channel for scanning a column.
 *
 * Below the routing threshold it is marked, since that is the line at which
 * the system itself would not act on the value unattended.
 */
export function Confidence({
  value,
  threshold = 0.75,
}: {
  value: number;
  threshold?: number;
}) {
  const percent = Math.round(value * 100);
  const weak = value < threshold;

  return (
    <span className="inline-flex items-center gap-1.5" title={`Confidence ${percent}%`}>
      <span
        aria-hidden
        className="h-1 w-8 overflow-hidden rounded-full bg-border"
      >
        <span
          className={`block h-full ${weak ? "bg-warn" : "bg-ok"}`}
          style={{ width: `${Math.max(percent, 2)}%` }}
        />
      </span>
      <span
        className={`font-mono text-xs ${weak ? "text-warn" : "text-faint"}`}
      >
        {percent}
      </span>
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * Evidence
 * ------------------------------------------------------------------ */

/**
 * The transcript segments a field was drawn from.
 *
 * Clicking one scrolls the transcript to it. A classification that cannot
 * point at a segment is usually an inference the transcript does not support,
 * so "no evidence" is rendered as a warning rather than omitted.
 */
export function Evidence({
  segments,
  onSelect,
}: {
  segments: string[];
  onSelect?: (segmentId: string) => void;
}) {
  if (segments.length === 0) {
    return (
      <span className="text-xs text-warn" title="Nothing in the transcript supports this">
        no evidence
      </span>
    );
  }

  return (
    <span className="inline-flex gap-1">
      {segments.map((id) => (
        <button
          key={id}
          type="button"
          onClick={() => onSelect?.(id)}
          className="rounded border border-border px-1 font-mono text-xs text-faint transition-colors hover:border-accent hover:text-accent"
          title={`Jump to segment ${id}`}
        >
          {id}
        </button>
      ))}
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * Escalation
 * ------------------------------------------------------------------ */

const TRIGGER_LABEL: Record<string, string> = {
  life_threat_indicated: "Life threat",
  caller_is_involved: "Caller is the victim",
  child_involved: "Child involved",
  hazard_indicated: "Hazard on scene",
  system_degraded: "System degraded",
  caller_requested_human: "Caller asked for a person",
  contradictory_information: "Contradictory information",
  asr_quality_poor: "Poor audio",
  language_unsupported: "Language not supported",
  silence_or_no_response: "No response",
  low_confidence: "Low confidence",
};

/**
 * Escalation triggers.
 *
 * Rendered as a persistent band rather than a dismissible alert. An escalated
 * incident is one the system is explicitly saying it cannot handle alone; that
 * state does not stop being true because someone clicked a close button.
 *
 * The most operationally significant trigger leads, because the API already
 * ranks them and a truncated list should keep what changes handling most.
 */
export function Escalation({ triggers }: { triggers: string[] }) {
  if (triggers.length === 0) return null;

  const lifeThreat = triggers.includes("life_threat_indicated");

  return (
    <div
      role="status"
      className={`flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2 text-sm ${
        lifeThreat
          ? "border-danger/40 bg-danger/10 text-danger"
          : "border-warn/30 bg-warn/8 text-warn"
      }`}
    >
      <span className="font-semibold uppercase tracking-wide text-xs">
        {lifeThreat ? "Escalated · life threat" : "Escalated"}
      </span>
      <span className="text-muted">
        {triggers.map((t) => TRIGGER_LABEL[t] ?? t.replace(/_/g, " ")).join(" · ")}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Layout helpers
 * ------------------------------------------------------------------ */

export function Panel({
  title,
  action,
  children,
  className = "",
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`border-b border-border ${className}`}>
      <header className="flex items-center justify-between gap-3 px-4 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-faint">
          {title}
        </h2>
        {action}
      </header>
      {children}
    </section>
  );
}

/**
 * An empty state that teaches rather than announcing nothing.
 *
 * "No units" and "we do not know where this is" are different answers needing
 * different next actions from the call-taker, so the reason is always shown.
 */
export function Empty({ children }: { children: ReactNode }) {
  return <p className="px-4 py-3 text-sm text-faint">{children}</p>;
}

/** Skeleton rows, never a spinner over content. */
export function SkeletonRows({ rows = 6 }: { rows?: number }) {
  return (
    <div className="space-y-px" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-2.5">
          <div className="h-3 w-8 rounded bg-raised" />
          <div className="h-3 flex-1 rounded bg-raised opacity-70" />
          <div className="h-3 w-14 rounded bg-raised opacity-50" />
        </div>
      ))}
    </div>
  );
}
