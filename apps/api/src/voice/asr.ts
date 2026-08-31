import type { SpeakerRole, SpokenLanguage } from "@resqai/schema";

/**
 * Speech recognition.
 *
 * The interface is streaming-shaped rather than request/response because the
 * thing being modelled is a live call: audio arrives continuously, provisional
 * text arrives before settled text, and the pipeline has to make decisions
 * before the caller has finished speaking.
 *
 * ## Why Whisper is not here
 *
 * Whisper is the obvious default and it is the wrong choice for this. On
 * code-switched Indian speech it reliably *translates* rather than transcribes
 * — "Shiv Mandir ke peeche" comes back as "behind the Shiva temple". For a
 * general transcription product that is a quality quibble. Here it destroys
 * the single most actionable thing in the call: the exact string a local
 * dispatcher recognises. The transcript is also the evidence an operator
 * checks the classification against, and a translated transcript cannot serve
 * that purpose.
 *
 * So the requirement is a recogniser that transcribes Indic languages *in
 * their own script* and code-switches without normalising. Sarvam and Bhashini
 * both do; several better-known engines do not.
 */

/** A recognition result. Provisional until `is_final`. */
export interface AsrSegment {
  text: string;
  /** 0-1. Never invented — null when the engine does not report one. */
  confidence: number | null;
  language: SpokenLanguage;
  speaker: SpeakerRole;
  start_ms: number;
  end_ms: number;
  /**
   * False for provisional text the engine may revise.
   *
   * Extraction must never run on provisional text. Streaming recognisers emit
   * a first guess within a few hundred milliseconds and correct it as more
   * audio arrives, and a classification built on "there's a fire" that the
   * engine later settles as "there's no fire" is worse than no classification.
   */
  is_final: boolean;
}

export interface AsrSession {
  /** Feeds an audio chunk. Format is agreed at session start. */
  write(chunk: Buffer): void;
  /** Signals end of audio and waits for any trailing final results. */
  close(): Promise<void>;
  readonly engine: string;
}

export interface AsrSessionOptions {
  /**
   * Languages to expect. Passing several enables code-switched recognition on
   * engines that support it, which is the normal case here rather than an
   * edge case.
   */
  languages: SpokenLanguage[];
  sampleRate: number;
  encoding: "linear16" | "mulaw" | "opus";
  onSegment: (segment: AsrSegment) => void;
  onError: (error: Error) => void;
}

export interface AsrProvider {
  readonly name: string;
  /** Opens a streaming session. Rejects if the engine is unreachable. */
  open(options: AsrSessionOptions): Promise<AsrSession>;
}

export class AsrUnavailable extends Error {
  constructor(
    public readonly engine: string,
    cause: string,
  ) {
    super(`ASR engine ${engine} unavailable: ${cause}`);
    this.name = "AsrUnavailable";
  }
}

/* ------------------------------------------------------------------ *
 * Sarvam
 * ------------------------------------------------------------------ */

/**
 * Sarvam AI streaming recognition.
 *
 * Chosen as the default because it is built for Indian speech specifically —
 * it transcribes Indic scripts natively and handles Hindi-English
 * code-switching without collapsing it to one language, which is the exact
 * failure mode that rules out the better-known engines here.
 *
 * The socket is deliberately thin. Every recognition result is handed straight
 * to the caller with its confidence attached and nothing inferred; the session
 * manager decides what a partial means and when to act on it.
 */
export class SarvamAsrProvider implements AsrProvider {
  readonly name = "sarvam";

  constructor(
    private readonly config: {
      apiKey: string;
      endpoint?: string;
      model?: string;
    },
  ) {}

  async open(options: AsrSessionOptions): Promise<AsrSession> {
    const endpoint = this.config.endpoint ?? "wss://api.sarvam.ai/speech-to-text/ws";
    const url = new URL(endpoint);
    url.searchParams.set("model", this.config.model ?? "saarika:v2");
    url.searchParams.set("sample_rate", String(options.sampleRate));
    url.searchParams.set("encoding", options.encoding);
    // Several language hints rather than one: code-switched speech is the
    // normal case on this path, not an exception to handle later.
    url.searchParams.set("language_hints", options.languages.join(","));

    const socket = new WebSocket(url, {
      headers: { "api-subscription-key": this.config.apiKey },
    } as unknown as string[]);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new AsrUnavailable(this.name, "connection timed out")),
        5_000,
      );
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve();
      });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new AsrUnavailable(this.name, "connection failed"));
      });
    });

    socket.addEventListener("message", (event) => {
      try {
        const payload = JSON.parse(String(event.data)) as {
          transcript?: string;
          confidence?: number;
          language_code?: string;
          is_final?: boolean;
          start_time_ms?: number;
          end_time_ms?: number;
        };

        if (!payload.transcript) return;

        options.onSegment({
          text: payload.transcript,
          // Null rather than a default when the engine is silent. A fabricated
          // confidence would feed the quality assessment and the escalation
          // decision with a number nobody measured.
          confidence: typeof payload.confidence === "number" ? payload.confidence : null,
          language: normaliseLanguage(payload.language_code),
          // Telephony gives us one inbound audio stream, so everything on it
          // is the caller. No vendor speaker label is consulted, so none can
          // be wrong — the same rule the text adapters follow.
          speaker: "caller",
          start_ms: payload.start_time_ms ?? 0,
          end_ms: payload.end_time_ms ?? 0,
          is_final: payload.is_final ?? false,
        });
      } catch (err) {
        options.onError(err instanceof Error ? err : new Error(String(err)));
      }
    });

    socket.addEventListener("error", () => {
      options.onError(new AsrUnavailable(this.name, "stream error"));
    });

    return {
      engine: `${this.name}:${this.config.model ?? "saarika:v2"}`,
      write(chunk) {
        if (socket.readyState === 1) socket.send(chunk);
      },
      async close() {
        if (socket.readyState === 1) {
          socket.send(JSON.stringify({ event: "end" }));
          // Trailing finals arrive after the end signal; closing immediately
          // would drop the last thing the caller said, which on this path is
          // frequently the most important thing they said.
          await new Promise((resolve) => setTimeout(resolve, 750));
        }
        socket.close();
      },
    };
  }
}

const LANGUAGE_CODES: Record<string, SpokenLanguage> = {
  "hi-IN": "hi",
  "en-IN": "en",
  "bn-IN": "bn",
  "ta-IN": "ta",
  "te-IN": "te",
  "mr-IN": "mr",
  "gu-IN": "gu",
  "kn-IN": "kn",
  "ml-IN": "ml",
  "pa-IN": "pa",
  "or-IN": "or",
  "as-IN": "as",
  "ur-IN": "ur",
};

function normaliseLanguage(code: string | undefined): SpokenLanguage {
  if (!code) return "unknown";
  return LANGUAGE_CODES[code] ?? (LANGUAGE_CODES[`${code}-IN`] ?? "unknown");
}

/* ------------------------------------------------------------------ *
 * Scripted provider, for tests and demonstrations
 * ------------------------------------------------------------------ */

export interface ScriptedUtterance {
  text: string;
  confidence?: number | null;
  language?: SpokenLanguage;
  /** Delay before this utterance, simulating speech timing. */
  after_ms?: number;
  /** Emit a provisional version first, then correct it. */
  partial_first?: string;
}

/**
 * Replays a fixed script as if it were live recognition.
 *
 * Two jobs. It makes the whole voice path — partials, finals, rolling
 * extraction, quality assessment, escalation — testable with no telephony
 * account, no ASR credentials and no audio, which is the same property that
 * has kept every other milestone testable.
 *
 * It also drives demonstrations. A pitch cannot depend on a live phone call
 * connecting, and a scripted call that exercises the real pipeline is a far
 * more honest demonstration than a mocked screen.
 */
export class ScriptedAsrProvider implements AsrProvider {
  readonly name = "scripted";

  constructor(
    private readonly script: ScriptedUtterance[],
    /** Speed multiplier. Tests run at 0 for instant replay. */
    private readonly speed = 1,
  ) {}

  async open(options: AsrSessionOptions): Promise<AsrSession> {
    let cancelled = false;
    let elapsed = 0;

    const run = (async () => {
      for (const utterance of this.script) {
        if (cancelled) return;

        const gap = utterance.after_ms ?? 1500;
        if (this.speed > 0) {
          await new Promise((resolve) => setTimeout(resolve, gap * this.speed));
        }
        elapsed += gap;
        if (cancelled) return;

        // A provisional result first, then the correction — the shape a real
        // streaming recogniser produces, and the reason `is_final` exists.
        if (utterance.partial_first) {
          options.onSegment({
            text: utterance.partial_first,
            confidence: pickConfidence(utterance, 0.8),
            language: utterance.language ?? "hi",
            speaker: "caller",
            start_ms: elapsed - gap,
            end_ms: elapsed,
            is_final: false,
          });
        }

        options.onSegment({
          text: utterance.text,
          confidence: pickConfidence(utterance, 0.9),
          language: utterance.language ?? "hi",
          speaker: "caller",
          start_ms: elapsed - gap,
          end_ms: elapsed,
          is_final: true,
        });
      }
    })();

    return {
      engine: "scripted",
      write() {
        // Audio is ignored; the script is the input.
      },
      async close() {
        cancelled = true;
        await run;
      },
    };
  }
}

/**
 * Distinguishes an unspecified confidence from an explicitly null one.
 *
 * The nullish-coalescing operator collapses the two, which silently replaced a
 * deliberate null with a default — inventing a confidence figure inside the
 * one test written to prove confidence is never invented. An engine that
 * reports nothing must stay null the whole way through, because that value
 * feeds the quality assessment and the escalation decision.
 */
function pickConfidence(
  utterance: ScriptedUtterance,
  fallback: number,
): number | null {
  return "confidence" in utterance ? (utterance.confidence ?? null) : fallback;
}
