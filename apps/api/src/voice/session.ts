import {
  assessQuality,
  triageIsSettled,
  type SpokenLanguage,
  type TranscriptSegment,
  type TriageExtraction,
} from "@resqai/schema";

import type { AsrProvider, AsrSegment, AsrSession } from "./asr.js";
import type { ExtractionService } from "../extraction/service.js";
import type { TriageService } from "../extraction/triage.js";
import type { IncidentRepository, IncidentRow } from "../repository/incidents.js";
import { evaluateEscalation, mergeTriggers } from "../domain/escalation.js";
import { chooseSummary, mergeExtraction } from "../domain/merge.js";
import { SYSTEM } from "../repository/incidents.js";

/**
 * A live voice call.
 *
 * The difference from text intake is not the transport, it is time. A text
 * message is complete when it arrives; a call is a thing that is still
 * happening, and the system has to be useful before it ends.
 *
 * That produces the central design here: **two extraction tiers running at
 * different rhythms.**
 *
 *   fast triage   2-4 s    type + priority + life threat
 *   full pass     12-20 s  everything, with evidence and location
 *
 * Measured, not assumed — see the note in `TriageExtraction`. The fast pass
 * gives a call-taker a lane and a priority while the caller is still speaking;
 * the full pass fills in the record behind it. Waiting twenty seconds for one
 * complete answer would mean the first useful output arrives after the window
 * in which it was most useful.
 *
 * Three invariants hold throughout:
 *
 *  1. **Extraction never runs on provisional text.** Streaming recognisers
 *     revise their first guess, and a classification built on text the engine
 *     later corrects is worse than none.
 *  2. **A slower pass never overwrites a newer one.** Every pass records how
 *     much transcript it saw, and a result computed from less transcript than
 *     is already applied is discarded rather than written.
 *  3. **Passes of the same tier never overlap.** A second pass launched while
 *     one is in flight would race it to the same row.
 */

/** Segments to accumulate before the first fast pass. */
const TRIAGE_MIN_SEGMENTS = 1;

/** Minimum gap between full passes, in milliseconds. */
const FULL_PASS_INTERVAL_MS = 15_000;

export interface VoiceSessionConfig {
  repo: IncidentRepository;
  asr: AsrProvider;
  triage: TriageService;
  extraction: ExtractionService;
  /** Languages to expect. Several enables code-switched recognition. */
  languages?: SpokenLanguage[];
  sampleRate?: number;
  encoding?: "linear16" | "mulaw" | "opus";
  onWarning?: (message: string) => void;
}

export interface VoiceCallResult {
  incidentId: string;
  reference: string;
  segments: number;
  triagePasses: number;
  fullPasses: number;
  /** Milliseconds from call start to the first usable classification. */
  timeToTriageMs: number | null;
}

export class VoiceSession {
  private asrSession: AsrSession | null = null;

  private readonly segments: TranscriptSegment[] = [];
  /** The current provisional utterance, replaced as the engine revises it. */
  private partial: AsrSegment | null = null;

  /** In-flight segment writes, awaited before the call is declared over. */
  private readonly pendingWrites = new Set<Promise<unknown>>();

  private triage: TriageExtraction | null = null;
  private triageInFlight = false;
  private fullInFlight = false;

  /** Highest segment index reflected in what is stored. Guards invariant 2. */
  private appliedThrough = -1;

  private lastFullPassAt = 0;
  private triagePasses = 0;
  private fullPasses = 0;
  private startedAt = 0;
  private timeToTriageMs: number | null = null;
  private ended = false;

  constructor(
    private readonly config: VoiceSessionConfig,
    private incident: IncidentRow,
  ) {}

  /** Opens the recogniser and begins accepting audio. */
  async start(): Promise<void> {
    this.startedAt = Date.now();

    this.asrSession = await this.config.asr.open({
      languages: this.config.languages ?? ["hi", "en"],
      sampleRate: this.config.sampleRate ?? 8000,
      encoding: this.config.encoding ?? "mulaw",
      onSegment: (segment) => this.onSegment(segment),
      onError: (error) => {
        // A recognition failure degrades the call rather than ending it. The
        // audio is still connected and a call-taker can still hear it; what is
        // lost is the assistance, and that must be visible rather than silent.
        this.config.onWarning?.(`ASR error: ${error.message}`);
        void this.markDegraded(error.message);
      },
    });

    await this.config.repo.setAsrEngine(
      this.incident.incident_id,
      this.asrSession.engine,
    );
  }

  write(chunk: Buffer): void {
    this.asrSession?.write(chunk);
  }

  /** The incident this call is building. */
  get incidentId(): string {
    return this.incident.incident_id;
  }

  /** The provisional utterance, for live display in the console. */
  get currentPartial(): string | null {
    return this.partial?.text ?? null;
  }

  /**
   * Ends the call.
   *
   * Always runs a final full pass regardless of the interval, because the last
   * thing a caller says before hanging up is frequently the most important
   * thing they said, and it would otherwise sit unprocessed behind a debounce.
   */
  async end(reason = "completed"): Promise<VoiceCallResult> {
    this.ended = true;
    await this.asrSession?.close();

    // Every utterance durable before anything else. The transcript is the one
    // thing this system promises to keep even when everything else fails.
    await Promise.allSettled([...this.pendingWrites]);

    // Let any pass already in flight finish before the closing one, so the
    // final result is genuinely the last word rather than a race.
    await this.settle();
    await this.runFullPass();

    /*
     * The session closes the call, and does it once, with its own numbers.
     *
     * `endCall` only matches a call that is still open, so a caller who tried
     * to record the reason afterwards would find their write silently ignored
     * — the call would be closed with a null reason and no timing. The session
     * is the only thing that knows how long triage took, so it is the only
     * thing that should be closing the record.
     */
    await this.config.repo.endCall(this.incident.incident_id, {
      reason,
      firstTriageMs: this.timeToTriageMs,
      triagePasses: this.triagePasses,
      fullPasses: this.fullPasses,
    });

    return {
      incidentId: this.incident.incident_id,
      reference: this.incident.reference,
      segments: this.segments.length,
      triagePasses: this.triagePasses,
      fullPasses: this.fullPasses,
      timeToTriageMs: this.timeToTriageMs,
    };
  }

  /* ---------------- recognition ---------------- */

  private onSegment(segment: AsrSegment): void {
    if (!segment.is_final) {
      // Held for display only. Nothing downstream reads provisional text.
      this.partial = segment;
      return;
    }

    this.partial = null;

    const index = this.segments.length;
    const stored: TranscriptSegment = {
      id: `s${index}`,
      index,
      speaker: segment.speaker,
      text: segment.text,
      text_en: null,
      language: segment.language,
      asr_confidence: segment.confidence,
      start_ms: segment.start_ms,
      end_ms: segment.end_ms,
      received_at: new Date().toISOString(),
      is_final: true,
    };

    this.segments.push(stored);

    /*
     * Persisted immediately and independently of extraction. A transcript that
     * survives a model outage is the floor this system guarantees; losing the
     * caller's words because a classifier was rate-limited is not acceptable.
     *
     * The write is not awaited here — the recogniser callback must return
     * promptly or audio backs up behind it — but it *is* tracked, so `end()`
     * can wait for every segment to be durable before declaring the call over.
     * Without that the session reports a completed call while its last
     * utterances are still in flight, and a crash in that window loses exactly
     * the words that mattered most.
     */
    const write = this.config.repo
      .appendSegment(this.incident.incident_id, stored)
      .catch((err: unknown) =>
        this.config.onWarning?.(
          `could not store segment ${index}: ${err instanceof Error ? err.message : err}`,
        ),
      );

    this.pendingWrites.add(write);
    void write.finally(() => this.pendingWrites.delete(write));

    void this.schedule();
  }

  /* ---------------- scheduling ---------------- */

  private async schedule(): Promise<void> {
    if (this.ended) return;

    // The fast pass runs until the lane and priority settle. After that it
    // buys nothing — the full pass refines from there — and continuing would
    // pay for a call every few seconds until the caller hangs up.
    if (
      !this.triageInFlight &&
      this.segments.length >= TRIAGE_MIN_SEGMENTS &&
      !triageIsSettled(this.triage)
    ) {
      void this.runTriagePass();
    }

    const sinceFull = Date.now() - this.lastFullPassAt;
    if (!this.fullInFlight && sinceFull >= FULL_PASS_INTERVAL_MS) {
      void this.runFullPass();
    }
  }

  private async runTriagePass(): Promise<void> {
    this.triageInFlight = true;
    const through = this.segments.length - 1;

    try {
      const result = await this.config.triage.run(this.segments);
      this.triagePasses += 1;

      if (!result.triage) return;
      this.triage = result.triage;

      if (this.timeToTriageMs === null) {
        this.timeToTriageMs = Date.now() - this.startedAt;
      }

      // The full pass owns the record once it has run past this point.
      // Applying an older, narrower triage over it would regress the incident.
      if (through <= this.appliedThrough) return;

      await this.applyTriage(result.triage, through);
    } catch (err) {
      this.config.onWarning?.(
        `triage pass failed: ${err instanceof Error ? err.message : err}`,
      );
    } finally {
      this.triageInFlight = false;
    }
  }

  private async runFullPass(): Promise<void> {
    if (this.segments.length === 0) return;

    this.fullInFlight = true;
    this.lastFullPassAt = Date.now();
    const through = this.segments.length - 1;

    try {
      const outcome = await this.config.extraction.run(this.segments);
      this.fullPasses += 1;

      const fresh = await this.config.repo.requireById(this.incident.incident_id);

      await this.config.repo.recordExtractionPass({
        incidentId: fresh.incident_id,
        pass: await this.config.repo.nextPassNumber(fresh.incident_id),
        throughSegmentIndex: outcome.throughSegmentIndex,
        result: outcome.core,
        modelId: outcome.modelId,
        promptVersion: outcome.promptVersion,
        contractVersion: outcome.contractVersion,
        latencyMs: outcome.latencyMs,
        problems: outcome.problems,
        error: outcome.error,
      });

      if (!outcome.core) return;

      // Invariant 2. A pass that started before a newer one finished saw less
      // of the call, and writing it now would undo the newer understanding.
      if (through < this.appliedThrough) {
        this.config.onWarning?.(
          `discarded a full pass computed through s${through}; s${this.appliedThrough} already applied`,
        );
        return;
      }

      const quality = assessQuality(this.segments);
      const merge = mergeExtraction(fresh.fields, outcome.core);

      const triggers = evaluateEscalation({
        extraction: outcome.core,
        // Voice is the one channel where this is real. Poor audio is a
        // condition a call-taker can act on — ask the caller to move, or take
        // the call over — rather than a mysterious absence of extracted fields.
        quality,
        systemDegraded: outcome.error !== null,
        problems: outcome.problems,
        languageSupported: true,
      });

      const updated = await this.config.repo.applyExtraction(
        fresh.incident_id,
        fresh.version,
        {
          fields: merge.fields,
          summary: chooseSummary(fresh.summary, outcome.core.summary),
          overallConfidence: outcome.core.overall_confidence,
          escalationTriggers: mergeTriggers(fresh.escalation_triggers, triggers),
          degradedMode: outcome.error !== null || outcome.degradedFields.length > 0,
          updatedFields: merge.updated,
          preservedFields: merge.preserved,
          contested: merge.contested,
          modelId: outcome.modelId,
          passNumber: this.fullPasses,
        },
      );

      await this.config.repo.setTranscriptQuality(fresh.incident_id, quality);

      this.incident = updated;
      this.appliedThrough = through;
    } catch (err) {
      this.config.onWarning?.(
        `full pass failed: ${err instanceof Error ? err.message : err}`,
      );
    } finally {
      this.fullInFlight = false;
    }
  }

  /**
   * Applies a triage result.
   *
   * Writes only the two fields it produced, and only where a human has not
   * already decided them — the same rule the full pass follows. A fast pass is
   * still a machine proposal, and being fast does not give it authority over a
   * call-taker who has already confirmed something.
   */
  private async applyTriage(
    triage: TriageExtraction,
    through: number,
  ): Promise<void> {
    const fresh = await this.config.repo.requireById(this.incident.incident_id);

    const proposals: Record<string, unknown> = { ...fresh.fields };
    const updated: string[] = [];

    const propose = (name: string, value: unknown) => {
      const existing = fresh.fields[name] as { review?: { state?: string } } | undefined;
      if (existing?.review?.state && existing.review.state !== "ai_proposed") return;
      if (value === "unclear" || value === null) return;

      proposals[name] = {
        value,
        status: "extracted",
        confidence: triage.confidence,
        // The fast grammar carries no evidence — citing segments costs tokens
        // on the path where latency is the constraint. The full pass supplies
        // provenance a few seconds later, and until then the field shows as
        // having none, which is honest.
        evidence: [],
        review: {
          state: "ai_proposed",
          reviewed_by: null,
          reviewed_at: null,
          override_reason: null,
          superseded_value: null,
        },
      };
      updated.push(name);
    };

    propose("incident_type", triage.incident_type);
    propose("priority", triage.priority);

    if (updated.length === 0) return;

    const triggers: string[] = [];
    if (triage.life_threat) triggers.push("life_threat_indicated");
    if (triage.needs_human) triggers.push("caller_requested_human");
    if (triage.confidence < 0.75) triggers.push("low_confidence");

    const result = await this.config.repo.applyExtraction(
      fresh.incident_id,
      fresh.version,
      {
        fields: proposals,
        summary: fresh.summary,
        overallConfidence: triage.confidence,
        escalationTriggers: mergeTriggers(
          fresh.escalation_triggers,
          triggers as never[],
        ),
        degradedMode: fresh.degraded_mode,
        updatedFields: updated,
        preservedFields: [],
        contested: [],
        modelId: `${this.config.triage.modelId} (triage)`,
        passNumber: this.triagePasses,
      },
    );

    this.incident = result;
    this.appliedThrough = through;
  }

  /* ---------------- helpers ---------------- */

  /** Waits for any in-flight passes to finish. */
  private async settle(): Promise<void> {
    const deadline = Date.now() + 25_000;
    while ((this.triageInFlight || this.fullInFlight) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  private async markDegraded(reason: string): Promise<void> {
    try {
      const fresh = await this.config.repo.requireById(this.incident.incident_id);
      await this.config.repo.applyExtraction(fresh.incident_id, fresh.version, {
        fields: fresh.fields,
        summary: fresh.summary,
        overallConfidence: fresh.overall_confidence,
        escalationTriggers: mergeTriggers(fresh.escalation_triggers, [
          "system_degraded",
          "asr_quality_poor",
        ]),
        degradedMode: true,
        updatedFields: [],
        preservedFields: [],
        contested: [],
        modelId: `asr-failure: ${reason.slice(0, 60)}`,
        passNumber: 0,
      });
    } catch {
      // Already degraded, or the row moved. Nothing further to do.
    }
  }
}
