import type { SpokenLanguage } from "@resqai/schema";

/**
 * Translation.
 *
 * The important design point: **translation is for humans, not for the
 * extractor.**
 *
 * The extraction model reads the original text, in its original language and
 * script. It is not fed a translation. Translating first would repeat the
 * mistake that makes Whisper unusable on Indian audio — it translates rather
 * than transcribes, and place names, proper nouns and code-switched phrasing do
 * not survive the round trip. "Shiv Mandir ke peeche" becoming "behind the
 * Shiva temple" loses the exact string a local dispatcher would recognise.
 *
 * So `text_en` exists for one purpose: a call-taker who does not read the
 * caller's language. That makes translation an accessibility feature on the
 * display path, not a step in the extraction pipeline — which in turn means it
 * must never block extraction. If translation is slow or unavailable, the
 * incident still gets classified.
 */

export interface TranslationRequest {
  text: string;
  from: SpokenLanguage;
  to: "en";
}

export interface TranslationResult {
  /** Null when translation was unavailable or unnecessary. */
  text: string | null;
  provider: string;
  /** True when the source was already English, or empty. */
  skipped: boolean;
}

export interface TranslationProvider {
  readonly name: string;
  translate(request: TranslationRequest): Promise<TranslationResult>;
}

/**
 * The no-op provider.
 *
 * Used when no translation service is configured. It returns null rather than
 * echoing the source text back: a `text_en` that silently contains untranslated
 * Hindi is worse than an absent one, because the console would present it as an
 * English rendering and a call-taker would trust it.
 */
export class NullTranslator implements TranslationProvider {
  readonly name = "null";

  async translate(request: TranslationRequest): Promise<TranslationResult> {
    const unnecessary = request.from === "en" || request.text.trim() === "";
    return { text: null, provider: this.name, skipped: unnecessary };
  }
}

/**
 * Bhashini — MeitY's National Language Translation Mission.
 *
 * Chosen as the default real provider for three reasons: it covers all 22
 * scheduled languages, it is free at the volumes an MVP sees, and building on
 * government language infrastructure is a meaningful signal in a
 * government-adjacent pitch.
 *
 * The pipeline calls this off the critical path, so its latency does not delay
 * classification.
 */
export class BhashiniTranslator implements TranslationProvider {
  readonly name = "bhashini";

  constructor(
    private readonly config: {
      endpoint: string;
      apiKey: string;
      pipelineId: string;
      /** Beyond this, give up and leave the segment untranslated. */
      timeoutMs?: number;
    },
  ) {}

  async translate(request: TranslationRequest): Promise<TranslationResult> {
    if (request.from === "en" || !request.text.trim()) {
      return { text: null, provider: this.name, skipped: true };
    }

    // `mixed` has no source-language code to send. Bhashini expects a single
    // source language, and code-switched input is exactly what it handles
    // least well — so we route it as Hindi, which is the majority component of
    // Hinglish, and accept the imperfection on a display-only path.
    const sourceLanguage = request.from === "mixed" ? "hi" : request.from;

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.config.timeoutMs ?? 3_000,
    );

    try {
      const response = await fetch(this.config.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: this.config.apiKey,
        },
        signal: controller.signal,
        body: JSON.stringify({
          pipelineTasks: [
            {
              taskType: "translation",
              config: {
                language: {
                  sourceLanguage,
                  targetLanguage: request.to,
                },
              },
            },
          ],
          inputData: { input: [{ source: request.text }] },
        }),
      });

      if (!response.ok) {
        return { text: null, provider: this.name, skipped: false };
      }

      const body = (await response.json()) as {
        pipelineResponse?: Array<{ output?: Array<{ target?: string }> }>;
      };
      const target = body.pipelineResponse?.[0]?.output?.[0]?.target ?? null;

      return { text: target, provider: this.name, skipped: false };
    } catch {
      // Timeout, network failure, malformed response — all the same outcome.
      // Translation is optional; the incident proceeds untranslated.
      return { text: null, provider: this.name, skipped: false };
    } finally {
      clearTimeout(timer);
    }
  }
}
