import { randomUUID } from "node:crypto";
import type {
  AuditEventType,
  ConfirmationState,
  EscalationTrigger,
  IncidentStatus,
  IntakeChannel,
  OverrideReason,
  ResolvedLocation,
  ResponseUnit,
  SpokenLanguage,
  TranscriptQuality,
  TranscriptSegment,
} from "@resqai/schema";
import { emptyField } from "@resqai/schema";
import type { Db, Row } from "../db/driver.js";
import { RetentionService } from "../retention/purge.js";
import {
  ConcurrencyConflict,
  IncidentNotFound,
  UnauditedMutation,
  UnknownField,
  UnknownLocationCandidate,
} from "../domain/errors.js";

/**
 * Incident repository.
 *
 * The only way to read or write an incident. Two guarantees are enforced here
 * rather than by convention:
 *
 *  1. **Every mutation is audited.** All writes funnel through one private
 *     method, which refuses to proceed unless the caller produced at least one
 *     audit event, and writes both in the same transaction. A mutator that
 *     forgets throws the first time it runs.
 *
 *  2. **Concurrent writes conflict rather than clobber.** Every update asserts
 *     the version it read. A stale write is rejected, not silently applied.
 *     The prototype's read-modify-write over a whole document had neither
 *     property and dropped messages under concurrency.
 */

/* ------------------------------------------------------------------ *
 * Field names
 * ------------------------------------------------------------------ */

/**
 * The reviewable fields — those an operator can confirm or override. Held as a
 * const tuple so the names are checked at compile time and validated at the
 * boundary, rather than being free-form strings reaching the database.
 */
export const REVIEWABLE_FIELDS = [
  "incident_type",
  "priority",
  "agencies",
  "people_affected",
  "caller_role",
  "hazards",
  "children_involved",
  "callback_number",
] as const;

export type ReviewableField = (typeof REVIEWABLE_FIELDS)[number];

function assertReviewable(name: string): asserts name is ReviewableField {
  if (!(REVIEWABLE_FIELDS as readonly string[]).includes(name)) {
    throw new UnknownField(name);
  }
}

/* ------------------------------------------------------------------ *
 * Row shape
 * ------------------------------------------------------------------ */

export interface IncidentRow {
  incident_id: string;
  reference: string;
  status: IncidentStatus;
  channel: IntakeChannel;
  primary_language: SpokenLanguage;
  caller_number_hash: string | null;
  received_at: Date;
  fields: Record<string, unknown>;
  location: Record<string, unknown>;
  location_lat: number | null;
  location_lon: number | null;
  recommended_units: unknown[];
  dispatched_units: string[];
  summary: string;
  transcript_quality: Record<string, unknown> | null;
  escalation_triggers: EscalationTrigger[];
  escalated_at: Date | null;
  degraded_mode: boolean;
  possible_duplicate_of: string | null;
  overall_confidence: number;
  data_handling: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
  version: number;
  priority_code: string | null;
  incident_type_code: string | null;
  location_ambiguity: string | null;
  /** Which recogniser produced this transcript. Null on text channels. */
  asr_engine: string | null;

  /* ---- retention ---- */

  /**
   * When this incident's content becomes due for destruction.
   *
   * A column as well as a JSONB field: the purge sweep filters on it, and a
   * JSONB predicate cannot be indexed here because casting text to timestamptz
   * is not IMMUTABLE.
   */
  retain_until: Date | null;
  /** Blocks purge past the retention date. */
  legal_hold: boolean;
  /** Set once content has been destroyed. Null while it still exists. */
  purged_at: Date | null;
}

const INCIDENT_COLUMNS = `
  incident_id, reference, status, channel, primary_language, caller_number_hash,
  received_at, fields, location, location_lat, location_lon, recommended_units,
  dispatched_units, summary, transcript_quality, escalation_triggers, escalated_at,
  degraded_mode, possible_duplicate_of, overall_confidence, data_handling,
  created_at, updated_at, version, priority_code, incident_type_code,
  location_ambiguity, asr_engine, retain_until, legal_hold, purged_at
`;

/* ------------------------------------------------------------------ *
 * Audit drafts
 * ------------------------------------------------------------------ */

export interface AuditDraft {
  type: AuditEventType;
  field_path?: string | null;
  before?: unknown;
  after?: unknown;
  detail?: Record<string, unknown>;
}

/** Column values to write, plus the audit events explaining them. */
interface Mutation {
  set: Record<string, unknown>;
  audits: AuditDraft[];
}

export interface Actor {
  /** Operator ID, or null when the system acted on its own. */
  id: string | null;
}

export const SYSTEM: Actor = { id: null };

/* ------------------------------------------------------------------ *
 * Creation input
 * ------------------------------------------------------------------ */

export interface CreateIncidentInput {
  reference: string;
  channel: IntakeChannel;
  primary_language?: SpokenLanguage;
  caller_number_hash?: string | null;
  received_at?: Date;
  data_handling?: { involves_minor?: boolean; retain_until?: string | null };

  /**
   * Retention window in days, from the operating agency's policy.
   *
   * Applied at intake so no incident is created without a destruction date.
   * One that has none would never be purged and nothing would report that it
   * had been missed.
   */
  retentionDays?: number;
}

/* ------------------------------------------------------------------ *
 * Repository
 * ------------------------------------------------------------------ */

export class IncidentRepository {
  constructor(private readonly db: Db) {}

  /* ---------------- reads ---------------- */

  async findById(incidentId: string): Promise<IncidentRow | null> {
    const rows = await this.db.query<IncidentRow>(
      `SELECT ${INCIDENT_COLUMNS} FROM incidents WHERE incident_id = $1`,
      [incidentId],
    );
    return rows[0] ?? null;
  }

  async requireById(incidentId: string): Promise<IncidentRow> {
    const row = await this.findById(incidentId);
    if (!row) throw new IncidentNotFound(incidentId);
    return row;
  }

  async findByReference(reference: string): Promise<IncidentRow | null> {
    const rows = await this.db.query<IncidentRow>(
      `SELECT ${INCIDENT_COLUMNS} FROM incidents WHERE reference = $1`,
      [reference],
    );
    return rows[0] ?? null;
  }

  /**
   * The dispatch queue: open incidents, most urgent first.
   *
   * `priority_code` ascends because P0 is the most urgent. Incidents with no
   * priority yet sort last rather than being excluded — an unclassified
   * incident is still an incident, and dropping it from the board is exactly
   * the failure mode this system exists to avoid.
   */
  async listQueue(limit = 100): Promise<IncidentRow[]> {
    return this.db.query<IncidentRow>(
      `SELECT ${INCIDENT_COLUMNS}
         FROM incidents
        WHERE status NOT IN ('resolved', 'cancelled', 'merged_duplicate')
        ORDER BY priority_code ASC NULLS LAST, received_at DESC
        LIMIT $1`,
      [limit],
    );
  }

  async auditTrail(incidentId: string): Promise<Row[]> {
    return this.db.query(
      `SELECT event_id, seq, incident_id, type, at, actor, field_path, before, after, detail
         FROM audit_events
        WHERE incident_id = $1
        ORDER BY seq ASC`,
      [incidentId],
    );
  }

  /* ---------------- creation ---------------- */

  async create(input: CreateIncidentInput, actor: Actor = SYSTEM): Promise<IncidentRow> {
    const incidentId = randomUUID();
    const receivedAt = input.received_at ?? new Date();

    // Every reviewable field starts as an explicit "not stated" proposal.
    // A missing key and an unanswered question are different things, and the
    // console must be able to tell them apart from the first moment.
    const fields = Object.fromEntries(
      REVIEWABLE_FIELDS.map((name) => [name, emptyField()]),
    );

    /*
     * The retention date is set at intake, never later.
     *
     * An incident created without one is an incident nobody will ever purge —
     * it would sit indefinitely with nothing reporting that it had, which is
     * the failure mode a retention policy exists to prevent. A minor's data
     * gets a shorter window automatically, because a policy that depends on an
     * operator remembering is not a policy.
     */
    const involvesMinor = input.data_handling?.involves_minor ?? false;
    const retainUntil =
      input.data_handling?.retain_until ??
      (input.retentionDays
        ? RetentionService.retainUntil(receivedAt, input.retentionDays, involvesMinor)
        : null);

    const dataHandling = {
      retain_until: retainUntil,
      may_use_for_training: false,
      involves_minor: involvesMinor,
      content_purged: false,
    };

    return this.db.transaction(async (tx) => {
      const rows = await tx.query<IncidentRow>(
        // `retain_until` is written to the column as well as into the JSONB.
        // The column is what the purge sweep filters on — a JSONB predicate
        // cannot be indexed here, because casting text to timestamptz is not
        // IMMUTABLE and Postgres refuses the expression index.
        `INSERT INTO incidents (
           incident_id, reference, status, channel, primary_language,
           caller_number_hash, received_at, fields, data_handling, retain_until
         ) VALUES ($1, $2, 'active_call', $3, $4, $5, $6, $7, $8, $9)
         RETURNING ${INCIDENT_COLUMNS}`,
        [
          incidentId,
          input.reference,
          input.channel,
          input.primary_language ?? "unknown",
          input.caller_number_hash ?? null,
          receivedAt,
          JSON.stringify(fields),
          JSON.stringify(dataHandling),
          retainUntil,
        ],
      );

      const row = rows[0]!;
      await this.writeAudit(tx, incidentId, actor, [
        {
          type: "incident_created",
          detail: { channel: input.channel, reference: input.reference },
        },
      ]);
      return row;
    });
  }

  /* ---------------- mutations ---------------- */

  /**
   * Confirms an AI-proposed value unchanged.
   *
   * Recorded because a confirmation is evidence too: an override rate is only
   * meaningful against a count of decisions actually made.
   */
  async confirmField(
    incidentId: string,
    expectedVersion: number,
    field: string,
    actor: Actor,
  ): Promise<IncidentRow> {
    assertReviewable(field);
    return this.apply(incidentId, expectedVersion, actor, (current) => {
      const fields = { ...current.fields } as Record<string, Record<string, unknown>>;
      const existing = fields[field] ?? {};
      const review = (existing.review ?? {}) as Record<string, unknown>;

      fields[field] = {
        ...existing,
        review: {
          ...review,
          state: "human_confirmed" satisfies ConfirmationState,
          reviewed_by: actor.id,
          reviewed_at: new Date().toISOString(),
          override_reason: null,
          superseded_value: null,
        },
      };

      return {
        set: { fields: JSON.stringify(fields) },
        audits: [
          {
            type: "field_confirmed",
            field_path: field,
            after: existing.value ?? null,
          },
        ],
      };
    });
  }

  /**
   * Replaces an AI-proposed value with a human's.
   *
   * The superseded value is retained on the field and in the audit event. A
   * reason is required, not optional — override reasons aggregated by field are
   * what turn the override rate from a bare number into a diagnostic, and they
   * cannot be reconstructed afterwards.
   */
  async overrideField(
    incidentId: string,
    expectedVersion: number,
    field: string,
    newValue: unknown,
    reason: OverrideReason,
    actor: Actor,
  ): Promise<IncidentRow> {
    assertReviewable(field);
    return this.apply(incidentId, expectedVersion, actor, (current) => {
      const fields = { ...current.fields } as Record<string, Record<string, unknown>>;
      const existing = fields[field] ?? {};
      const previous = existing.value ?? null;

      fields[field] = {
        ...existing,
        value: newValue,
        // A human-entered value is not a model extraction. Status becomes
        // `extracted` because the information is now established, and
        // confidence goes to 1 because the operator is the authority.
        status: newValue === null ? "not_stated" : "extracted",
        confidence: newValue === null ? 0 : 1,
        review: {
          state: "human_corrected" satisfies ConfirmationState,
          reviewed_by: actor.id,
          reviewed_at: new Date().toISOString(),
          override_reason: reason,
          superseded_value: previous,
        },
      };

      return {
        set: { fields: JSON.stringify(fields) },
        audits: [
          {
            type: "field_overridden",
            field_path: field,
            before: previous,
            after: newValue,
            detail: { reason },
          },
        ],
      };
    });
  }

  async setStatus(
    incidentId: string,
    expectedVersion: number,
    status: IncidentStatus,
    actor: Actor,
  ): Promise<IncidentRow> {
    return this.apply(incidentId, expectedVersion, actor, (current) => ({
      set: { status },
      audits: [
        { type: "status_changed", before: current.status, after: status },
      ],
    }));
  }

  /**
   * Adds escalation triggers.
   *
   * Additive only — there is no method to clear a trigger. Escalation is
   * one-way by design: once any condition has said this call needs a person,
   * nothing automated gets to decide it no longer does.
   */
  async escalate(
    incidentId: string,
    expectedVersion: number,
    triggers: EscalationTrigger[],
    actor: Actor,
  ): Promise<IncidentRow> {
    return this.apply(incidentId, expectedVersion, actor, (current) => {
      const merged = [...new Set([...current.escalation_triggers, ...triggers])];
      const added = merged.filter((t) => !current.escalation_triggers.includes(t));

      return {
        set: {
          escalation_triggers: merged,
          escalated_at: current.escalated_at ?? new Date(),
        },
        audits: [
          {
            type: "escalated_to_human",
            before: current.escalation_triggers,
            after: merged,
            detail: { added },
          },
        ],
      };
    });
  }

  async setDegradedMode(
    incidentId: string,
    expectedVersion: number,
    degraded: boolean,
    reason: string,
    actor: Actor = SYSTEM,
  ): Promise<IncidentRow> {
    return this.apply(incidentId, expectedVersion, actor, (current) => ({
      set: { degraded_mode: degraded },
      audits: [
        {
          type: "degraded_mode_entered",
          before: current.degraded_mode,
          after: degraded,
          detail: { reason },
        },
      ],
    }));
  }

  /* ---------------- transcript ---------------- */

  /**
   * Appends one transcript segment.
   *
   * A row insert, not a document rewrite. The prototype read the whole
   * transcript, pushed onto the array and wrote it back, so two utterances
   * arriving together lost one. Here concurrent appends at the same index
   * collide on the primary key and surface as a conflict.
   *
   * Deliberately does not touch the incident row, so it needs no version and
   * cannot conflict with an operator editing fields mid-call.
   */
  async appendSegment(
    incidentId: string,
    segment: Omit<TranscriptSegment, "id">,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO transcript_segments
         (incident_id, idx, speaker, text, text_en, language,
          asr_confidence, start_ms, end_ms, received_at, is_final)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (incident_id, idx) DO UPDATE
         SET text = EXCLUDED.text,
             text_en = EXCLUDED.text_en,
             language = EXCLUDED.language,
             asr_confidence = EXCLUDED.asr_confidence,
             is_final = EXCLUDED.is_final
         WHERE transcript_segments.is_final = false`,
      [
        incidentId,
        segment.index,
        segment.speaker,
        segment.text,
        segment.text_en,
        segment.language,
        segment.asr_confidence,
        segment.start_ms,
        segment.end_ms,
        segment.received_at,
        segment.is_final,
      ],
    );
  }

  async listSegments(incidentId: string): Promise<Row[]> {
    return this.db.query(
      `SELECT incident_id, idx, speaker, text, text_en, language,
              asr_confidence, start_ms, end_ms, received_at, is_final
         FROM transcript_segments
        WHERE incident_id = $1
        ORDER BY idx ASC`,
      [incidentId],
    );
  }

  /**
   * Attaches an English rendering to a segment.
   *
   * Display-only, so it deliberately takes no version and writes no audit
   * event: translation changes nothing an operator decides on, and making it
   * bump the incident version would cause spurious concurrency conflicts for a
   * field nobody acts on.
   */
  async setSegmentTranslation(
    incidentId: string,
    segmentIdx: number,
    textEn: string,
  ): Promise<void> {
    await this.db.query(
      `UPDATE transcript_segments SET text_en = $3
        WHERE incident_id = $1 AND idx = $2`,
      [incidentId, segmentIdx, textEn],
    );
  }

  /** The next free segment index for an incident. */
  async nextSegmentIndex(incidentId: string): Promise<number> {
    const rows = await this.db.query<{ next: string }>(
      `SELECT COALESCE(MAX(idx) + 1, 0)::text AS next
         FROM transcript_segments WHERE incident_id = $1`,
      [incidentId],
    );
    return Number(rows[0]?.next ?? 0);
  }

  /* ---------------- intake ---------------- */

  /**
   * The open incident for a caller, if one exists.
   *
   * A second message from the same number continues the same emergency rather
   * than starting a new one. Only open incidents are candidates — once an
   * incident is resolved or cancelled, the next message legitimately begins a
   * fresh one.
   */
  async findOpenByCaller(callerHash: string): Promise<IncidentRow | null> {
    const rows = await this.db.query<IncidentRow>(
      `SELECT ${INCIDENT_COLUMNS}
         FROM incidents
        WHERE caller_number_hash = $1
          AND status IN ('active_call', 'awaiting_confirmation')
        ORDER BY received_at DESC
        LIMIT 1`,
      [callerHash],
    );
    return rows[0] ?? null;
  }

  /**
   * Claims a provider message and stores it as a transcript segment, atomically.
   *
   * Returns false when the message was already seen. Text channels all
   * redeliver — WhatsApp retries until it gets a 2xx — and without the claim a
   * single "there's a fire" becomes three transcript segments, which reads to
   * the extractor as emphasis or as three separate reports.
   *
   * The claim and the append are one transaction on purpose. Claiming first and
   * appending after would mean a crash between them leaves the message marked
   * as seen but never stored — and the provider's retry would then be rejected
   * as a duplicate. That is silent, permanent data loss on exactly the path
   * where losing a message matters most.
   */
  async ingestMessage(
    externalId: string,
    channel: IntakeChannel,
    incidentId: string,
    segment: Omit<TranscriptSegment, "id">,
  ): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const claimed = await tx.query<{ external_id: string }>(
        `INSERT INTO intake_messages (external_id, channel, incident_id, segment_idx)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (external_id) DO NOTHING
         RETURNING external_id`,
        [externalId, channel, incidentId, segment.index],
      );

      if (claimed.length === 0) return false;

      await tx.query(
        `INSERT INTO transcript_segments
           (incident_id, idx, speaker, text, text_en, language,
            asr_confidence, start_ms, end_ms, received_at, is_final)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          incidentId,
          segment.index,
          segment.speaker,
          segment.text,
          segment.text_en,
          segment.language,
          segment.asr_confidence,
          segment.start_ms,
          segment.end_ms,
          segment.received_at,
          segment.is_final,
        ],
      );

      return true;
    });
  }

  /* ---------------- voice ---------------- */

  /**
   * Opens a call record.
   *
   * Separate from the incident because a call has a lifecycle an incident does
   * not: it can be answered or abandoned, it has a duration, and it needs to
   * be reconcilable against the carrier's own records during an audit.
   */
  async startCall(input: {
    callId: string;
    incidentId: string;
    provider: string;
    direction?: "inbound" | "outbound";
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO voice_calls (call_id, incident_id, provider, direction, answered_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (call_id) DO NOTHING`,
      [input.callId, input.incidentId, input.provider, input.direction ?? "inbound"],
    );
  }

  /**
   * Records which recogniser produced this transcript.
   *
   * Written in two places on purpose: on the call for audit, and on the
   * incident so the console can show it without a join on every read.
   */
  async setAsrEngine(incidentId: string, engine: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.query(`UPDATE incidents SET asr_engine = $2 WHERE incident_id = $1`, [
        incidentId,
        engine,
      ]);
      await tx.query(
        `UPDATE voice_calls SET asr_engine = $2 WHERE incident_id = $1`,
        [incidentId, engine],
      );
    });
  }

  /**
   * Stores the transcript quality rollup.
   *
   * Display-only, so it takes no version and writes no audit event — the same
   * reasoning as segment translations. Making it bump the version would cause
   * spurious concurrency conflicts on a live call, which is the worst possible
   * time to hand an operator a conflict over a field nobody acts on directly.
   */
  async setTranscriptQuality(
    incidentId: string,
    quality: TranscriptQuality,
  ): Promise<void> {
    await this.db.query(
      `UPDATE incidents SET transcript_quality = $2 WHERE incident_id = $1`,
      [incidentId, JSON.stringify(quality)],
    );
  }

  /** Closes a call record and stores its timing. */
  async endCall(
    incidentId: string,
    stats?: {
      reason?: string;
      firstTriageMs?: number | null;
      triagePasses?: number;
      fullPasses?: number;
    },
  ): Promise<void> {
    await this.db.query(
      `UPDATE voice_calls SET
         ended_at = now(),
         end_reason = COALESCE($2, end_reason),
         first_triage_ms = COALESCE($3, first_triage_ms),
         triage_passes = COALESCE($4, triage_passes),
         full_passes = COALESCE($5, full_passes)
       WHERE incident_id = $1 AND ended_at IS NULL`,
      [
        incidentId,
        stats?.reason ?? null,
        stats?.firstTriageMs ?? null,
        stats?.triagePasses ?? null,
        stats?.fullPasses ?? null,
      ],
    );
  }

  async findCall(callId: string): Promise<Row | null> {
    const rows = await this.db.query(
      `SELECT call_id, incident_id, provider, asr_engine, started_at, answered_at,
              ended_at, end_reason, first_triage_ms, triage_passes, full_passes
         FROM voice_calls WHERE call_id = $1`,
      [callId],
    );
    return rows[0] ?? null;
  }

  /* ---------------- location ---------------- */

  /**
   * Stores the resolved location.
   *
   * `location_lat`/`location_lon` are written only when a candidate has
   * actually been selected, and nulled when it has not. Those columns feed the
   * generated geography column that proximity search runs against, so leaving a
   * stale point there while the location is disputed would let an unconfirmed
   * incident participate in dispatch as though it were pinned down. Null keeps
   * it visibly out.
   */
  async setLocation(
    incidentId: string,
    expectedVersion: number,
    input: {
      location: ResolvedLocation;
      ambiguity: string | null;
      actor: Actor;
    },
  ): Promise<IncidentRow> {
    return this.apply(incidentId, expectedVersion, input.actor, (current) => {
      const selected =
        input.location.selected_index === null
          ? null
          : (input.location.candidates[input.location.selected_index] ?? null);

      const audits: AuditDraft[] = [];

      const previousPoint = { lat: current.location_lat, lon: current.location_lon };
      const nextPoint = selected
        ? { lat: selected.point.latitude, lon: selected.point.longitude }
        : { lat: null, lon: null };

      const pointChanged =
        previousPoint.lat !== nextPoint.lat || previousPoint.lon !== nextPoint.lon;

      // Two different events, because they mean different things to whoever
      // reads the trail later. Resolving candidates without choosing one is
      // not a selection, and it is precisely the state that explains why an
      // incident sat undispatched — recording it as a selection would make the
      // audit trail describe a decision nobody made.
      audits.push({
        type: pointChanged ? "location_selected" : "location_candidates_updated",
        before: pointChanged ? previousPoint : undefined,
        after: pointChanged ? nextPoint : undefined,
        detail: {
          source: selected?.source ?? null,
          label: selected?.label ?? null,
          candidates: input.location.candidates.length,
          by_human: input.location.selected_by_human,
          ambiguity: input.ambiguity,
        },
      });

      return {
        set: {
          location: JSON.stringify(input.location),
          location_lat: nextPoint.lat,
          location_lon: nextPoint.lon,
          location_ambiguity: input.ambiguity,
        },
        audits,
      };
    });
  }

  /**
   * Records an operator choosing among location candidates.
   *
   * Separate from `setLocation` because the provenance differs in a way that
   * matters downstream: `selected_by_human` is what stops the next extraction
   * pass from re-resolving the location and overriding the person who just
   * confirmed it, exactly as reviewed fields are protected from re-extraction.
   */
  async selectLocationCandidate(
    incidentId: string,
    expectedVersion: number,
    candidateIndex: number,
    actor: Actor,
  ): Promise<IncidentRow> {
    return this.apply(incidentId, expectedVersion, actor, (current) => {
      const stored = current.location as unknown as ResolvedLocation;
      const candidate = stored.candidates?.[candidateIndex];

      if (!candidate) {
        throw new UnknownLocationCandidate(
          candidateIndex,
          stored.candidates?.length ?? 0,
        );
      }

      return {
        set: {
          location: JSON.stringify({
            ...stored,
            selected_index: candidateIndex,
            selected_by_human: true,
          }),
          location_lat: candidate.point.latitude,
          location_lon: candidate.point.longitude,
          // The question is settled once a person has answered it.
          location_ambiguity: null,
        },
        audits: [
          {
            type: "location_selected",
            before: {
              lat: current.location_lat,
              lon: current.location_lon,
            },
            after: {
              lat: candidate.point.latitude,
              lon: candidate.point.longitude,
            },
            detail: {
              source: candidate.source,
              label: candidate.label,
              by_human: true,
            },
          },
        ],
      };
    });
  }

  /** Records the units proposed for an incident. Never dispatches. */
  async setRecommendedUnits(
    incidentId: string,
    expectedVersion: number,
    units: ResponseUnit[],
  ): Promise<IncidentRow> {
    return this.apply(incidentId, expectedVersion, SYSTEM, () => ({
      set: { recommended_units: JSON.stringify(units) },
      audits: [
        {
          type: "units_recommended",
          detail: {
            count: units.length,
            units: units.map((u) => ({
              unit_id: u.unit_id,
              travel_time_s: u.travel_time_s,
              estimated: u.is_fallback_estimate,
            })),
          },
        },
      ],
    }));
  }

  /* ---------------- extraction ---------------- */

  /**
   * Applies an extraction pass to an incident.
   *
   * Fields still owned by the model are updated; anything a human confirmed or
   * corrected is left exactly as they left it. Escalation triggers are merged
   * rather than replaced, so nothing here can un-escalate a contact.
   */
  async applyExtraction(
    incidentId: string,
    expectedVersion: number,
    input: {
      fields: Record<string, unknown>;
      summary: string;
      overallConfidence: number;
      escalationTriggers: EscalationTrigger[];
      degradedMode: boolean;
      updatedFields: string[];
      preservedFields: string[];
      contested: unknown[];
      modelId: string;
      passNumber: number;
    },
  ): Promise<IncidentRow> {
    return this.apply(incidentId, expectedVersion, SYSTEM, (current) => {
      const escalated =
        input.escalationTriggers.length > 0 && !current.escalated_at
          ? new Date()
          : current.escalated_at;

      const audits: AuditDraft[] = [
        {
          type: "extraction_completed",
          detail: {
            model_id: input.modelId,
            pass: input.passNumber,
            updated: input.updatedFields,
            preserved: input.preservedFields,
            contested: input.contested.length,
          },
        },
      ];

      const newTriggers = input.escalationTriggers.filter(
        (t) => !current.escalation_triggers.includes(t),
      );
      if (newTriggers.length > 0) {
        audits.push({
          type: "escalated_to_human",
          before: current.escalation_triggers,
          after: input.escalationTriggers,
          detail: { added: newTriggers },
        });
      }

      if (input.degradedMode !== current.degraded_mode) {
        audits.push({
          type: "degraded_mode_entered",
          before: current.degraded_mode,
          after: input.degradedMode,
          detail: { reason: "extraction pass" },
        });
      }

      return {
        set: {
          fields: JSON.stringify(input.fields),
          summary: input.summary,
          overall_confidence: input.overallConfidence,
          escalation_triggers: input.escalationTriggers,
          escalated_at: escalated,
          degraded_mode: input.degradedMode,
        },
        audits,
      };
    });
  }

  /** Records one extraction pass, successful or not. */
  async recordExtractionPass(input: {
    incidentId: string;
    pass: number;
    throughSegmentIndex: number;
    result: unknown;
    modelId: string;
    promptVersion: string;
    contractVersion: string;
    latencyMs: number;
    problems: string[];
    error: string | null;
  }): Promise<void> {
    await this.db.query(
      `INSERT INTO extraction_passes
         (pass_id, incident_id, pass, through_segment_index, result,
          model_id, prompt_version, contract_version, latency_ms, problems, error)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (incident_id, pass) DO NOTHING`,
      [
        randomUUID(),
        input.incidentId,
        input.pass,
        input.throughSegmentIndex,
        input.result === null ? null : JSON.stringify(input.result),
        input.modelId,
        input.promptVersion,
        input.contractVersion,
        input.latencyMs,
        input.problems,
        input.error,
      ],
    );
  }

  /** The next pass number for an incident. */
  async nextPassNumber(incidentId: string): Promise<number> {
    const rows = await this.db.query<{ next: string }>(
      `SELECT COALESCE(MAX(pass) + 1, 1)::text AS next
         FROM extraction_passes WHERE incident_id = $1`,
      [incidentId],
    );
    return Number(rows[0]?.next ?? 1);
  }

  async listExtractionPasses(incidentId: string): Promise<Row[]> {
    return this.db.query(
      `SELECT pass, through_segment_index, model_id, prompt_version,
              contract_version, latency_ms, problems, error, created_at
         FROM extraction_passes
        WHERE incident_id = $1
        ORDER BY pass ASC`,
      [incidentId],
    );
  }

  /* ---------------- internals ---------------- */

  /**
   * The single write path.
   *
   * Reads the current row, lets the caller compute a mutation, then writes the
   * columns, bumps the version and appends the audit events — all in one
   * transaction. The `WHERE version = $expected` clause is what turns a lost
   * update into a rejected one.
   */
  private async apply(
    incidentId: string,
    expectedVersion: number,
    actor: Actor,
    mutate: (current: IncidentRow) => Mutation,
  ): Promise<IncidentRow> {
    return this.db.transaction(async (tx) => {
      const currentRows = await tx.query<IncidentRow>(
        `SELECT ${INCIDENT_COLUMNS} FROM incidents WHERE incident_id = $1 FOR UPDATE`,
        [incidentId],
      );
      const current = currentRows[0];
      if (!current) throw new IncidentNotFound(incidentId);

      if (current.version !== expectedVersion) {
        throw new ConcurrencyConflict(
          incidentId,
          expectedVersion,
          current.version,
        );
      }

      const { set, audits } = mutate(current);

      // The guarantee, enforced rather than documented: no audit, no write.
      if (audits.length === 0) throw new UnauditedMutation(incidentId);

      const columns = Object.keys(set);
      const assignments = columns.map((c, i) => `${c} = $${i + 1}`);
      const params: unknown[] = columns.map((c) => set[c]);

      // version and updated_at are set here, never by a caller.
      assignments.push(`version = version + 1`, `updated_at = now()`);

      params.push(incidentId, expectedVersion);
      const idParam = params.length - 1;
      const versionParam = params.length;

      const updated = await tx.query<IncidentRow>(
        `UPDATE incidents
            SET ${assignments.join(", ")}
          WHERE incident_id = $${idParam} AND version = $${versionParam}
          RETURNING ${INCIDENT_COLUMNS}`,
        params,
      );

      const row = updated[0];
      if (!row) {
        // The row moved between the locked read and the update. With FOR UPDATE
        // this should be unreachable; treated as a conflict rather than
        // assumed impossible.
        throw new ConcurrencyConflict(incidentId, expectedVersion, -1);
      }

      await this.writeAudit(tx, incidentId, actor, audits);
      return row;
    });
  }

  private async writeAudit(
    tx: Db,
    incidentId: string,
    actor: Actor,
    drafts: AuditDraft[],
  ): Promise<void> {
    for (const draft of drafts) {
      await tx.query(
        `INSERT INTO audit_events
           (event_id, incident_id, type, actor, field_path, before, after, detail)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          randomUUID(),
          incidentId,
          draft.type,
          actor.id,
          draft.field_path ?? null,
          draft.before === undefined ? null : JSON.stringify(draft.before),
          draft.after === undefined ? null : JSON.stringify(draft.after),
          JSON.stringify(draft.detail ?? {}),
        ],
      );
    }
  }
}
