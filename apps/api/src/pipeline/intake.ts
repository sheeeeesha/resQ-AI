import { randomBytes } from "node:crypto";
import type {
  IntakeChannel,
  SpokenLanguage,
  TranscriptSegment,
} from "@resqai/schema";
import { assessQuality, IS_TEXT_CHANNEL } from "@resqai/schema";
import type { LocationCandidate, StatedLocation } from "@resqai/schema";

import { hashCallerId, normaliseInbound, type InboundMessage } from "../intake/adapters.js";
import { detectLanguage } from "../language/detect.js";
import { NullTranslator, type TranslationProvider } from "../language/translate.js";
import { evaluateEscalation, mergeTriggers } from "../domain/escalation.js";
import { chooseSummary, mergeExtraction } from "../domain/merge.js";
import { SYSTEM } from "../repository/incidents.js";
import type { ExtractionService } from "../extraction/service.js";
import type { IncidentRepository, IncidentRow } from "../repository/incidents.js";
import type { LocationResolver } from "../location/resolve.js";

/**
 * The text intake pipeline.
 *
 * Takes a raw channel payload and produces a stored, classified incident.
 * Sequenced before voice deliberately: text channels carry no recognition
 * error, so accuracy here reflects the extraction quality rather than the
 * transcription quality — which means when voice lands in M5, any accuracy
 * problem is unambiguously an ASR problem rather than an architecture problem.
 *
 * Ordering that matters:
 *
 *  - The message is claimed for idempotency **before** anything is written, so
 *    a redelivered webhook cannot become a second transcript segment.
 *  - Extraction reads the **original** text. Translation runs alongside it and
 *    updates the segment afterwards, so a slow or failed translation never
 *    delays classification.
 *  - Escalation is evaluated on every pass and merged, never replaced.
 */

/** Languages the extraction path is currently validated for. */
const SUPPORTED_LANGUAGES: ReadonlySet<SpokenLanguage> = new Set<SpokenLanguage>([
  "en",
  "hi",
  "mixed",
]);

export interface IntakeResult {
  incidentId: string;
  reference: string;
  /** True when this payload created the incident rather than continuing one. */
  created: boolean;
  /** True when the message had already been ingested and was ignored. */
  duplicate: boolean;
  segmentIndex: number;
  language: SpokenLanguage;
  /** Set when a location was resolved but nobody has confirmed which. */
  locationAmbiguity: string | null;
  escalated: boolean;
  degraded: boolean;
  /** Problems from this pass. Surfaced for logging, never thrown. */
  problems: string[];
}

export interface IntakePipelineConfig {
  repo: IncidentRepository;
  extraction: ExtractionService;
  callerSalt: string;
  translator?: TranslationProvider;
  /** Omit to skip location resolution entirely. */
  location?: LocationResolver;
  /** Two-letter state prefix for operator-facing references. */
  referencePrefix?: string;
}

export class IntakePipeline {
  private readonly translator: TranslationProvider;

  constructor(private readonly config: IntakePipelineConfig) {
    this.translator = config.translator ?? new NullTranslator();
  }

  /** Handles one raw channel payload, which may contain several messages. */
  async handle(channel: IntakeChannel, payload: unknown): Promise<IntakeResult[]> {
    const messages = normaliseInbound(channel, payload);
    const results: IntakeResult[] = [];

    // Sequentially, not concurrently: messages from one contact are ordered,
    // and processing them in parallel would race on segment indices and on the
    // incident version.
    for (const message of messages) {
      results.push(await this.handleMessage(message));
    }

    return results;
  }

  private async handleMessage(message: InboundMessage): Promise<IntakeResult> {
    const { repo } = this.config;
    const callerHash = hashCallerId(message.from, this.config.callerSalt);

    const existing = await repo.findOpenByCaller(callerHash);
    const detection = detectLanguage(message.text);

    let incident: IncidentRow;
    let created = false;

    if (existing) {
      incident = existing;
    } else {
      incident = await repo.create({
        reference: this.mintReference(),
        channel: message.channel,
        primary_language: detection.language,
        caller_number_hash: callerHash,
        received_at: new Date(message.sent_at),
      });
      created = true;
    }

    const segmentIndex = await repo.nextSegmentIndex(incident.incident_id);

    const segment: Omit<TranscriptSegment, "id"> = {
      index: segmentIndex,
      speaker: message.speaker,
      text: message.text,
      text_en: null,
      language: detection.language,
      // Text channels have no recognition step, so there is no confidence to
      // report. Null is the honest value; zero would read as "very uncertain".
      asr_confidence: null,
      start_ms: null,
      end_ms: null,
      received_at: message.sent_at,
      is_final: true,
    };

    // Claim and store together. A redelivered webhook stops here; a crash
    // mid-way leaves neither, so the provider's retry still works.
    const claimed = await repo.ingestMessage(
      message.external_id,
      message.channel,
      incident.incident_id,
      segment,
    );

    if (!claimed) {
      return {
        incidentId: incident.incident_id,
        reference: incident.reference,
        created: false,
        duplicate: true,
        segmentIndex: -1,
        language: detection.language,
        locationAmbiguity: incident.location_ambiguity,
        escalated: incident.escalation_triggers.length > 0,
        degraded: incident.degraded_mode,
        problems: [],
      };
    }

    const segments = await this.loadSegments(incident.incident_id);

    // Classification and translation run together. Extraction reads the
    // original text; translation is for the console only and must not gate it.
    const [outcome] = await Promise.all([
      this.config.extraction.run(segments, { language: detection.language }),
      this.translateInBackground(incident.incident_id, segmentIndex, message.text, detection.language),
    ]);

    const passNumber = await repo.nextPassNumber(incident.incident_id);

    await repo.recordExtractionPass({
      incidentId: incident.incident_id,
      pass: passNumber,
      throughSegmentIndex: outcome.throughSegmentIndex,
      result: outcome.core,
      modelId: outcome.modelId,
      promptVersion: outcome.promptVersion,
      contractVersion: outcome.contractVersion,
      latencyMs: outcome.latencyMs,
      problems: outcome.problems,
      error: outcome.error,
    });

    const quality = assessQuality(
      segments.map((s) => ({ ...s, id: `s${s.index}` }) as TranscriptSegment),
    );

    const triggers = evaluateEscalation({
      extraction: outcome.core,
      // Text channels have no ASR to assess. Passing quality here would report
      // a degraded transcript purely because there is no confidence to average.
      quality: IS_TEXT_CHANNEL[message.channel] ? null : quality,
      systemDegraded: outcome.error !== null,
      problems: outcome.problems,
      languageSupported: SUPPORTED_LANGUAGES.has(detection.language),
    });

    // Re-read: the pass may have taken seconds, and an operator may have
    // confirmed a field meanwhile. The merge has to run against current state.
    const fresh = await repo.requireById(incident.incident_id);

    const merge = outcome.core
      ? mergeExtraction(fresh.fields, outcome.core)
      : { fields: fresh.fields as never, updated: [], preserved: [], contested: [] };

    const updated = await repo.applyExtraction(
      fresh.incident_id,
      fresh.version,
      {
        fields: merge.fields,
        summary: chooseSummary(fresh.summary, outcome.core?.summary ?? ""),
        overallConfidence: outcome.core?.overall_confidence ?? 0,
        escalationTriggers: mergeTriggers(fresh.escalation_triggers, triggers),
        degradedMode: outcome.error !== null || outcome.degradedFields.length > 0,
        updatedFields: merge.updated,
        preservedFields: merge.preserved,
        contested: merge.contested,
        modelId: outcome.modelId,
        passNumber,
      },
    );

    const located = await this.resolveLocation(updated, message.text, outcome);

    return {
      incidentId: located.incident_id,
      reference: located.reference,
      created,
      duplicate: false,
      segmentIndex,
      language: detection.language,
      locationAmbiguity: located.location_ambiguity,
      escalated: located.escalation_triggers.length > 0,
      degraded: located.degraded_mode,
      problems: outcome.problems,
    };
  }

  /**
   * Resolves the incident location from this message.
   *
   * Runs after extraction because the stated landmark comes from it, and as a
   * separate versioned write because geocoding is a network call that can fail
   * or take seconds. Folding it into the extraction write would mean a slow
   * geocoder holding a row lock, and a geocoder outage discarding a
   * classification that was already complete.
   *
   * A location a human has already confirmed is never re-resolved — the same
   * rule that protects reviewed fields from a later extraction pass.
   */
  private async resolveLocation(
    incident: IncidentRow,
    text: string,
    outcome: { core: { location: { value: unknown } } | null },
  ): Promise<IncidentRow> {
    const resolver = this.config.location;
    if (!resolver) return incident;

    const stored = incident.location as unknown as {
      candidates?: LocationCandidate[];
      selected_by_human?: boolean;
    };

    if (stored?.selected_by_human) return incident;

    try {
      const resolved = await resolver.resolve({
        text,
        stated: (outcome.core?.location.value as StatedLocation | null) ?? null,
        existing: stored?.candidates ?? [],
        now: new Date().toISOString(),
      });

      if (resolved.location.candidates.length === 0) return incident;

      return await this.config.repo.setLocation(
        incident.incident_id,
        incident.version,
        { location: resolved.location, ambiguity: resolved.ambiguity, actor: SYSTEM },
      );
    } catch {
      // Location is additive. Losing it must not cost the classification that
      // already succeeded, so the incident stands with whatever it had.
      return incident;
    }
  }

  /** Loads the transcript in the shape the extractor expects. */
  private async loadSegments(incidentId: string): Promise<TranscriptSegment[]> {
    const rows = await this.config.repo.listSegments(incidentId);
    return rows.map((r) => ({
      id: `s${r.idx as number}`,
      index: r.idx as number,
      speaker: r.speaker as TranscriptSegment["speaker"],
      text: r.text as string,
      text_en: (r.text_en as string | null) ?? null,
      language: r.language as SpokenLanguage,
      asr_confidence: (r.asr_confidence as number | null) ?? null,
      start_ms: (r.start_ms as number | null) ?? null,
      end_ms: (r.end_ms as number | null) ?? null,
      received_at: new Date(r.received_at as string).toISOString(),
      is_final: r.is_final as boolean,
    }));
  }

  /**
   * Translates a segment for the console.
   *
   * Never throws and never blocks the caller's outcome: a failure here leaves
   * `text_en` null, which the console renders as "not translated" rather than
   * as an English rendering that is silently the original.
   */
  private async translateInBackground(
    incidentId: string,
    segmentIdx: number,
    text: string,
    from: SpokenLanguage,
  ): Promise<void> {
    try {
      const result = await this.translator.translate({ text, from, to: "en" });
      if (!result.text) return;

      await this.config.repo.setSegmentTranslation(incidentId, segmentIdx, result.text);
    } catch {
      // Deliberately swallowed. Translation is a display convenience.
    }
  }

  /**
   * Mints an operator-facing reference.
   *
   * Date plus random suffix rather than a per-day sequence: a sequence needs
   * coordination on every insert for a value nobody sorts by, and collisions
   * here are vanishingly unlikely. Worth revisiting if operators ask to read
   * references aloud over radio, where a shorter monotonic form reads better.
   */
  private mintReference(): string {
    const prefix = this.config.referencePrefix ?? "IN";
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const suffix = randomBytes(4).toString("hex").toUpperCase().slice(0, 6);
    return `${prefix}-${date}-${suffix}`;
  }
}
