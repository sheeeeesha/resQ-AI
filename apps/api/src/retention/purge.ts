import type { Db } from "../db/driver.js";
import type { Actor } from "../repository/incidents.js";

/**
 * Retention and purge, under the DPDP Act.
 *
 * The design is dictated by a constraint set in migration 001: the audit log is
 * append-only by trigger and cannot be deleted. That makes purge a content
 * operation rather than a deletion.
 *
 * **What is destroyed:** the transcript, the summary, the caller identifier,
 * the location text and every location candidate, the raw extraction results.
 * Everything a caller said or that identifies them.
 *
 * **What survives:** the incident row, its classification, its priority, its
 * timings, the units recommended and dispatched, and the complete audit trail.
 *
 * An auditor can still establish that a call happened, how it was classified,
 * who reviewed it, what was dispatched and when the content was destroyed.
 * What nobody can do afterwards is read what the caller said.
 *
 * A hard DELETE would take the audit trail with it — leaving no evidence the
 * incident existed at all, which is worse for accountability and no better for
 * privacy. And an operating agency needs the retained statistics: response
 * times, override rates, incident volumes by lane.
 */

export interface PurgeCandidate {
  incident_id: string;
  reference: string;
  retain_until: string | null;
  involves_minor: boolean;
}

export interface PurgeResult {
  purged: string[];
  /** Incidents due but held, with the reason. Reported, never purged. */
  held: Array<{ incident_id: string; reference: string; reason: string | null }>;
  errors: Array<{ incident_id: string; message: string }>;
}

export class RetentionService {
  constructor(private readonly db: Db) {}

  /**
   * Computes a retention date at intake.
   *
   * A minor's data carries heightened obligations under the DPDP Act, which in
   * practice means holding it no longer than necessary. The shorter window is
   * applied automatically rather than left to an operator to remember, because
   * a policy that depends on someone remembering is not a policy.
   */
  static retainUntil(
    receivedAt: Date,
    policyDays: number,
    involvesMinor: boolean,
  ): string {
    const days = involvesMinor ? Math.min(policyDays, 30) : policyDays;
    const until = new Date(receivedAt);
    until.setUTCDate(until.getUTCDate() + days);
    return until.toISOString();
  }

  /**
   * Gives a retention date to incidents created without one.
   *
   * Predates the policy, or was created by a path that did not supply the
   * window. Dated from `received_at` rather than from now, so backfilling
   * does not silently extend how long anything is kept.
   */
  async backfillUndated(policyDays: number): Promise<number> {
    const rows = await this.db.query<{ incident_id: string }>(
      `UPDATE incidents
          SET retain_until = received_at + make_interval(days => $1),
              data_handling = jsonb_set(
                data_handling,
                '{retain_until}',
                to_jsonb((received_at + make_interval(days => $1))::text)
              )
        WHERE retain_until IS NULL AND purged_at IS NULL
        RETURNING incident_id`,
      [policyDays],
    );
    return rows.length;
  }

  /** Incidents past their retention date and not held. */
  async due(now = new Date(), limit = 500): Promise<PurgeCandidate[]> {
    return this.db.query<PurgeCandidate>(
      `SELECT incident_id,
              reference,
              retain_until,
              (data_handling ->> 'involves_minor')::boolean AS involves_minor
         FROM incidents
        WHERE purged_at IS NULL
          AND legal_hold = false
          AND retain_until IS NOT NULL
          AND retain_until <= $1
        ORDER BY retain_until ASC
        LIMIT $2`,
      [now.toISOString(), limit],
    );
  }

  /** Incidents past their date but blocked by a hold. */
  async heldPastDue(now = new Date()): Promise<
    Array<{ incident_id: string; reference: string; reason: string | null }>
  > {
    return this.db.query(
      `SELECT incident_id, reference, legal_hold_reason AS reason
         FROM incidents
        WHERE purged_at IS NULL
          AND legal_hold = true
          AND retain_until IS NOT NULL
          AND retain_until <= $1
        ORDER BY received_at ASC`,
      [now.toISOString()],
    );
  }

  /**
   * Destroys the content of one incident.
   *
   * One transaction. A half-purged incident — transcript gone, caller hash
   * still present — is the worst of both outcomes: the operational value is
   * lost and the personal data is not.
   */
  async purge(incidentId: string, actor: Actor): Promise<void> {
    await this.db.transaction(async (tx) => {
      const rows = await tx.query<{
        reference: string;
        purged_at: Date | null;
        legal_hold: boolean;
        segment_count: string;
      }>(
        `SELECT i.reference, i.purged_at, i.legal_hold,
                (SELECT count(*)::text FROM transcript_segments s
                  WHERE s.incident_id = i.incident_id) AS segment_count
           FROM incidents i
          WHERE i.incident_id = $1
          FOR UPDATE`,
        [incidentId],
      );

      const incident = rows[0];
      if (!incident) throw new Error(`No such incident: ${incidentId}`);

      // Idempotent. A purge job that overlaps with itself, or is re-run after a
      // partial failure, must not produce a second purge event implying the
      // content was destroyed twice.
      if (incident.purged_at) return;

      // Checked inside the transaction as well as in the query that selected
      // this incident, because a hold may have been placed in between.
      if (incident.legal_hold) {
        throw new Error(`${incident.reference} is under legal hold`);
      }

      // The transcript. Rows are kept so the segment count and timings survive
      // as statistics, but every word is gone.
      await tx.query(
        `UPDATE transcript_segments
            SET text = '', text_en = NULL
          WHERE incident_id = $1`,
        [incidentId],
      );

      // The extraction history. The model, prompt version and latency stay —
      // those are how a past classification is attributed and how model
      // quality is reported. The result itself contained transcript content.
      await tx.query(
        `UPDATE extraction_passes SET result = NULL WHERE incident_id = $1`,
        [incidentId],
      );

      /*
       * The incident itself.
       *
       * `caller_number_hash` goes. It is a salted HMAC, which makes it
       * pseudonymous rather than anonymous — anyone holding the salt and a
       * candidate number can confirm a match, so under the DPDP Act it remains
       * personal data and does not survive a purge.
       *
       * Classification, priority, timings and dispatched units all stay: they
       * are the operating agency's statistics and contain nothing a caller
       * said.
       */
      await tx.query(
        `UPDATE incidents
            SET summary = '',
                caller_number_hash = NULL,
                location = jsonb_build_object(
                  'candidates', '[]'::jsonb,
                  'selected_index', NULL,
                  'selected_by_human', false,
                  'stated', NULL
                ),
                location_ambiguity = NULL,
                transcript_quality = NULL,
                -- Only the callback number is personal data. The other
                -- reviewable fields are classifications — type, priority,
                -- agencies, hazards, a people count — and those are the
                -- agency's statistics, containing nothing the caller said
                -- about themselves. Nulling them would destroy the
                -- operational record for no privacy gain.
                fields = jsonb_set(
                  fields,
                  '{callback_number,value}',
                  'null'::jsonb
                ),
                data_handling = jsonb_set(
                  data_handling, '{content_purged}', 'true'::jsonb
                ),
                purged_at = now(),
                updated_at = now()
          WHERE incident_id = $1`,
        [incidentId],
      );

      /*
       * The purge is itself audited, and that event is permanent.
       *
       * This is the property the append-only log buys: the trail states that a
       * transcript existed and when it was destroyed, forever, even though the
       * transcript is gone. An auditor asking "was there a call at 14:20 and
       * what happened to it" gets a complete answer.
       */
      await tx.query(
        `INSERT INTO audit_events (event_id, incident_id, type, actor, detail)
         VALUES (gen_random_uuid(), $1, 'content_purged', $2, $3)`,
        [
          incidentId,
          actor.id,
          JSON.stringify({
            segments_destroyed: Number(incident.segment_count),
            reason: "retention_policy",
          }),
        ],
      );
    });
  }

  /** Runs a purge sweep. Failures on one incident never stop the rest. */
  async sweep(actor: Actor, now = new Date()): Promise<PurgeResult> {
    const candidates = await this.due(now);
    const result: PurgeResult = { purged: [], held: [], errors: [] };

    for (const candidate of candidates) {
      try {
        await this.purge(candidate.incident_id, actor);
        result.purged.push(candidate.reference);
      } catch (err) {
        // One incident under an unexpected hold, or locked by a live call,
        // must not block the rest of a compliance sweep.
        result.errors.push({
          incident_id: candidate.incident_id,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    result.held = await this.heldPastDue(now);
    return result;
  }

  /* ---------------- legal hold ---------------- */

  /**
   * Places or releases a hold.
   *
   * Both directions are audited. "Why does this still exist" and "who released
   * it" are both questions someone eventually asks, and a hold that could be
   * lifted without a record would make the retention policy unenforceable.
   */
  async setLegalHold(
    incidentId: string,
    held: boolean,
    actor: Actor,
    reason: string | null,
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      const rows = await tx.query<{ purged_at: Date | null }>(
        `SELECT purged_at FROM incidents WHERE incident_id = $1 FOR UPDATE`,
        [incidentId],
      );

      if (!rows[0]) throw new Error(`No such incident: ${incidentId}`);

      // A hold on already-destroyed content preserves nothing and would
      // suggest to whoever reads it later that something was retained.
      if (rows[0].purged_at) {
        throw new Error("Content has already been purged; a hold preserves nothing");
      }

      await tx.query(
        `UPDATE incidents
            SET legal_hold = $2, legal_hold_reason = $3, updated_at = now()
          WHERE incident_id = $1`,
        [incidentId, held, held ? reason : null],
      );

      await tx.query(
        `INSERT INTO audit_events (event_id, incident_id, type, actor, detail)
         VALUES (gen_random_uuid(), $1, $2, $3, $4)`,
        [
          incidentId,
          held ? "legal_hold_placed" : "legal_hold_released",
          actor.id,
          JSON.stringify({ reason }),
        ],
      );
    });
  }

  /**
   * Compliance reporting: what is stored, what is overdue, what is held.
   *
   * `undated` is the number that matters most and is the easiest to miss. An
   * incident with no retention date is never selected by any purge sweep, so
   * it is retained forever while every other figure reports full compliance.
   * A report that showed "0 overdue" and stayed silent about it would be
   * actively misleading, which is worse than not reporting at all.
   */
  async status(now = new Date()): Promise<{
    total: number;
    purged: number;
    due: number;
    held: number;
    overdue_unheld: number;
    undated: number;
  }> {
    const rows = await this.db.query<Record<string, string>>(
      `SELECT
         count(*)::text AS total,
         count(*) FILTER (WHERE purged_at IS NOT NULL)::text AS purged,
         count(*) FILTER (WHERE legal_hold = true)::text AS held,
         count(*) FILTER (
           WHERE purged_at IS NULL
             AND retain_until <= $1
         )::text AS due,
         count(*) FILTER (
           WHERE purged_at IS NULL
             AND legal_hold = false
             AND retain_until <= $1
         )::text AS overdue_unheld,
         count(*) FILTER (
           WHERE purged_at IS NULL AND retain_until IS NULL
         )::text AS undated
       FROM incidents`,
      [now.toISOString()],
    );

    const row = rows[0] ?? {};
    return {
      total: Number(row.total ?? 0),
      purged: Number(row.purged ?? 0),
      due: Number(row.due ?? 0),
      held: Number(row.held ?? 0),
      overdue_unheld: Number(row.overdue_unheld ?? 0),
      undated: Number(row.undated ?? 0),
    };
  }
}
