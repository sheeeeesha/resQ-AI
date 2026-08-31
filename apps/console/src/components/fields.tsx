"use client";

import { useState } from "react";
import { Confidence, Evidence, FieldValue, Panel } from "./primitives";
import type { IncidentDetail, ReviewedField } from "@/lib/api";

/**
 * The review table.
 *
 * The screen a call-taker actually works. Every row answers four questions at
 * once: what did the machine decide, how sure was it, what in the transcript
 * supports that, and has a human signed off yet.
 *
 * Confirm and Correct are separate actions on purpose. Confirming is agreeing
 * with the machine; correcting is disagreeing with it. Collapsing both into an
 * editable cell would lose the distinction, and the override rate broken down
 * by field is the single most useful quality signal this system produces.
 */

const FIELD_LABEL: Record<string, string> = {
  incident_type: "Type",
  priority: "Priority",
  agencies: "Agencies",
  people_affected: "People affected",
  caller_role: "Caller",
  hazards: "Hazards",
  children_involved: "Child involved",
  callback_number: "Callback",
};

/** The order a call-taker checks things, not alphabetical. */
const FIELD_ORDER = [
  "incident_type",
  "priority",
  "agencies",
  "people_affected",
  "hazards",
  "children_involved",
  "caller_role",
  "callback_number",
];

const OVERRIDE_REASONS = [
  { value: "wrong_classification", label: "Wrong classification" },
  { value: "wrong_severity", label: "Wrong severity" },
  { value: "wrong_location", label: "Wrong location" },
  { value: "missed_detail", label: "Missed a detail" },
  { value: "caller_clarified", label: "Caller clarified" },
  { value: "local_knowledge", label: "Local knowledge" },
  { value: "policy_requires", label: "Policy requires it" },
  { value: "other", label: "Other" },
];

/** Value options per field, so correcting is a choice rather than free text. */
const FIELD_OPTIONS: Record<string, string[]> = {
  priority: ["P0_immediate", "P1_urgent", "P2_prompt", "P3_routine", "P4_referral"],
  caller_role: ["victim", "bystander", "family_member", "professional", "unknown"],
  children_involved: ["true", "false"],
};

export function Fields({
  incident,
  busy,
  onConfirm,
  onOverride,
  onEvidenceSelect,
}: {
  incident: IncidentDetail;
  busy: string | null;
  onConfirm: (field: string) => void;
  onOverride: (field: string, value: unknown, reason: string) => void;
  onEvidenceSelect: (segmentId: string) => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);

  const unreviewed = FIELD_ORDER.filter(
    (name) => incident.fields[name]?.review?.state === "ai_proposed",
  ).length;

  return (
    <Panel
      title="Classification"
      action={
        <span className="text-xs text-faint">
          {unreviewed === 0 ? (
            <span className="text-ok">all reviewed</span>
          ) : (
            `${unreviewed} awaiting review`
          )}
        </span>
      }
    >
      <table className="w-full text-sm">
        <thead className="sr-only">
          <tr>
            <th>Field</th>
            <th>Value</th>
            <th>Confidence</th>
            <th>Evidence</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {FIELD_ORDER.map((name) => {
            const field = incident.fields[name];
            if (!field) return null;

            return (
              <FieldRow
                key={name}
                name={name}
                field={field}
                editing={editing === name}
                busy={busy === name}
                onEdit={() => setEditing(editing === name ? null : name)}
                onConfirm={() => onConfirm(name)}
                onOverride={(value, reason) => {
                  onOverride(name, value, reason);
                  setEditing(null);
                }}
                onEvidenceSelect={onEvidenceSelect}
              />
            );
          })}
        </tbody>
      </table>
    </Panel>
  );
}

function FieldRow({
  name,
  field,
  editing,
  busy,
  onEdit,
  onConfirm,
  onOverride,
  onEvidenceSelect,
}: {
  name: string;
  field: ReviewedField;
  editing: boolean;
  busy: boolean;
  onEdit: () => void;
  onConfirm: () => void;
  onOverride: (value: unknown, reason: string) => void;
  onEvidenceSelect: (segmentId: string) => void;
}) {
  const proposed = field.review?.state === "ai_proposed";

  return (
    <>
      <tr className="border-t border-border/50 align-baseline hover:bg-raised/40">
        <th
          scope="row"
          className="w-36 px-4 py-2 text-left text-xs font-normal text-faint"
        >
          {FIELD_LABEL[name] ?? name}
        </th>

        <td className="py-2 pr-3">
          <FieldValue field={field} />
        </td>

        <td className="w-20 py-2 pr-3">
          {field.status === "extracted" && <Confidence value={field.confidence} />}
        </td>

        <td className="w-28 py-2 pr-3">
          {field.status === "extracted" && (
            <Evidence segments={field.evidence} onSelect={onEvidenceSelect} />
          )}
        </td>

        <td className="w-36 px-4 py-2 text-right">
          <div className="flex justify-end gap-1">
            {proposed && (
              <button
                type="button"
                onClick={onConfirm}
                disabled={busy}
                className="rounded border border-border px-2 py-0.5 text-xs text-muted transition-colors hover:border-ok hover:text-ok disabled:opacity-40"
              >
                {busy ? "…" : "Confirm"}
              </button>
            )}
            <button
              type="button"
              onClick={onEdit}
              disabled={busy}
              aria-expanded={editing}
              className="rounded border border-border px-2 py-0.5 text-xs text-muted transition-colors hover:border-accent hover:text-accent disabled:opacity-40"
            >
              {editing ? "Cancel" : "Correct"}
            </button>
          </div>
        </td>
      </tr>

      {editing && (
        <tr className="bg-raised/60">
          <td colSpan={5} className="px-4 py-3">
            <OverrideForm
              name={name}
              current={field.value}
              onSubmit={onOverride}
            />
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * The correction form.
 *
 * A reason is required, not optional. An override trail that cannot say *why*
 * an operator disagreed tells you the model was wrong but not how — and the
 * distribution of reasons is what turns overrides into training signal rather
 * than a list of complaints.
 */
function OverrideForm({
  name,
  current,
  onSubmit,
}: {
  name: string;
  current: unknown;
  onSubmit: (value: unknown, reason: string) => void;
}) {
  const options = FIELD_OPTIONS[name];
  const [value, setValue] = useState(
    options ? (options[0] ?? "") : stringify(current),
  );
  const [reason, setReason] = useState(OVERRIDE_REASONS[0]!.value);

  return (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(parse(name, value), reason);
      }}
    >
      <label className="flex flex-col gap-1">
        <span className="text-xs text-faint">Correct value</span>
        {options ? (
          <select
            value={value}
            onChange={(event) => setValue(event.target.value)}
            className="rounded border border-border bg-surface px-2 py-1 text-sm text-ink"
          >
            {options.map((option) => (
              <option key={option} value={option}>
                {option.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        ) : (
          <input
            value={value}
            onChange={(event) => setValue(event.target.value)}
            className="w-64 rounded border border-border bg-surface px-2 py-1 text-sm text-ink placeholder:text-faint"
            placeholder="New value"
          />
        )}
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-faint">Reason</span>
        <select
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          className="rounded border border-border bg-surface px-2 py-1 text-sm text-ink"
        >
          {OVERRIDE_REASONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      <button
        type="submit"
        className="rounded bg-accent px-3 py-1 text-sm font-medium text-accent-ink transition-colors hover:bg-accent-hover"
      >
        Save correction
      </button>
    </form>
  );
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Parses an operator's input back into the shape the contract expects. */
function parse(name: string, raw: string): unknown {
  if (name === "children_involved") return raw === "true";
  if (name === "agencies" || name === "hazards") {
    return raw
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
  }
  if (name === "people_affected") {
    const [min, max] = raw.split(/[-–]/).map((part) => Number(part.trim()));
    if (Number.isFinite(min)) {
      return { min, max: Number.isFinite(max) ? max : min };
    }
  }
  return raw;
}
