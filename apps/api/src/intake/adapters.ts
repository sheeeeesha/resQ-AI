import { createHmac } from "node:crypto";
import type { IntakeChannel, SpeakerRole } from "@resqai/schema";

/**
 * Channel adapters.
 *
 * Every inbound channel is normalised into one shape here, at the boundary, so
 * nothing downstream ever sees a vendor payload. Two things in particular are
 * pinned at this edge:
 *
 *  1. **Speaker roles.** Vendors disagree — some emit `user`/`assistant`, some
 *     `inbound`/`outbound`, some nothing at all. The prototype's emotion
 *     detection filtered on the literal string `"caller"` and would have
 *     matched nothing against a `user`/`assistant` feed, returning Neutral for
 *     every call while appearing to work perfectly. Roles are resolved here and
 *     never inferred again.
 *
 *  2. **Caller identity.** The raw phone number never leaves this module. It is
 *     hashed on the way in, because nothing downstream needs to read it back.
 */

/** A normalised inbound message, independent of which channel produced it. */
export interface InboundMessage {
  channel: IntakeChannel;
  /** Provider message ID, namespaced by channel. The idempotency key. */
  external_id: string;
  /** Caller identity as supplied — a phone number, or a web session ID. */
  from: string;
  text: string;
  sent_at: string;
  speaker: SpeakerRole;
}

export class UnsupportedPayload extends Error {
  constructor(channel: string, detail: string) {
    super(`Unsupported ${channel} payload: ${detail}`);
    this.name = "UnsupportedPayload";
  }
}

/* ------------------------------------------------------------------ *
 * Identity
 * ------------------------------------------------------------------ */

/**
 * Hashes a caller identifier.
 *
 * HMAC rather than a bare digest, and salted. Indian mobile numbers are a
 * 10-digit space with known prefixes — small enough to enumerate exhaustively
 * in seconds, so an unsalted SHA-256 of a phone number is a lookup table, not
 * a protection.
 *
 * Numbers are normalised to digits before hashing so `+91 98765 43210`,
 * `919876543210` and `09876543210` produce the same hash and therefore resolve
 * to the same open conversation.
 */
export function hashCallerId(raw: string, salt: string): string {
  const digits = raw.replace(/\D/g, "");
  // Indian numbers arrive with and without the country code. Normalise to the
  // 10-digit subscriber number so both forms match.
  const normalised =
    digits.length === 12 && digits.startsWith("91")
      ? digits.slice(2)
      : digits.length === 11 && digits.startsWith("0")
        ? digits.slice(1)
        : digits;

  const identity = normalised || raw.trim().toLowerCase();
  return `h1:${createHmac("sha256", salt).update(identity).digest("hex").slice(0, 32)}`;
}

/* ------------------------------------------------------------------ *
 * Speaker normalisation
 * ------------------------------------------------------------------ */

const SPEAKER_ALIASES: Record<string, SpeakerRole> = {
  caller: "caller",
  user: "caller",
  customer: "caller",
  inbound: "caller",
  from: "caller",
  call_taker: "call_taker",
  operator: "call_taker",
  agent: "call_taker",
  outbound: "call_taker",
  assistant: "ai_agent",
  bot: "ai_agent",
  ai: "ai_agent",
  system: "ai_agent",
};

/**
 * Maps a vendor's speaker label onto our roles.
 *
 * Returns `unknown` for anything unrecognised rather than assuming `caller`.
 * An unrecognised label is a signal that a vendor changed its payload, and
 * silently defaulting it to `caller` would corrupt every caller-only analysis
 * downstream — precisely the failure the prototype had.
 */
export function normaliseSpeaker(raw: string | undefined | null): SpeakerRole {
  if (!raw) return "unknown";
  return SPEAKER_ALIASES[raw.trim().toLowerCase()] ?? "unknown";
}

/* ------------------------------------------------------------------ *
 * WhatsApp
 * ------------------------------------------------------------------ */

/** The subset of the WhatsApp Cloud API webhook we depend on. */
interface WhatsAppWebhook {
  entry?: Array<{
    changes?: Array<{
      value?: {
        messages?: Array<{
          id?: string;
          from?: string;
          timestamp?: string;
          type?: string;
          text?: { body?: string };
        }>;
      };
    }>;
  }>;
}

/**
 * Normalises a WhatsApp Cloud API webhook.
 *
 * A single webhook can carry several messages, so this returns an array.
 * Non-text messages are dropped here rather than deeper in: images, audio and
 * location payloads are real and useful, but they belong to later milestones,
 * and passing them through as empty text would produce silent blanks in the
 * transcript.
 */
export function fromWhatsApp(payload: unknown): InboundMessage[] {
  const body = payload as WhatsAppWebhook;
  const messages =
    body?.entry?.flatMap(
      (e) => e.changes?.flatMap((c) => c.value?.messages ?? []) ?? [],
    ) ?? [];

  const out: InboundMessage[] = [];

  for (const message of messages) {
    if (message.type !== "text") continue;

    const text = message.text?.body?.trim();
    if (!text) continue;

    if (!message.id) throw new UnsupportedPayload("whatsapp", "message has no id");
    if (!message.from) throw new UnsupportedPayload("whatsapp", "message has no sender");

    out.push({
      channel: "whatsapp",
      external_id: `whatsapp:${message.id}`,
      from: message.from,
      text,
      // WhatsApp sends Unix seconds as a string.
      sent_at: message.timestamp
        ? new Date(Number(message.timestamp) * 1000).toISOString()
        : new Date().toISOString(),
      // Direction settles this: an inbound webhook message is from the citizen.
      // No vendor label is consulted, so no vendor label can be wrong.
      speaker: "caller",
    });
  }

  return out;
}

/* ------------------------------------------------------------------ *
 * SMS
 * ------------------------------------------------------------------ */

interface SmsPayload {
  MessageSid?: string;
  messageId?: string;
  From?: string;
  from?: string;
  Body?: string;
  body?: string;
  receivedAt?: string;
}

/** Normalises an SMS gateway callback. Tolerates Twilio and lowercase forms. */
export function fromSms(payload: unknown): InboundMessage[] {
  const p = payload as SmsPayload;

  const id = p.MessageSid ?? p.messageId;
  const from = p.From ?? p.from;
  const text = (p.Body ?? p.body ?? "").trim();

  if (!id) throw new UnsupportedPayload("sms", "no message id");
  if (!from) throw new UnsupportedPayload("sms", "no sender");
  if (!text) return [];

  return [
    {
      channel: "sms",
      external_id: `sms:${id}`,
      from,
      text,
      sent_at: p.receivedAt ?? new Date().toISOString(),
      speaker: "caller",
    },
  ];
}

/* ------------------------------------------------------------------ *
 * Web
 * ------------------------------------------------------------------ */

interface WebPayload {
  submissionId?: string;
  sessionId?: string;
  message?: string;
  contact?: string;
  submittedAt?: string;
}

/**
 * Normalises a web form or chat submission.
 *
 * `submissionId` is required rather than generated here: it is the idempotency
 * key, and one minted server-side would differ on every retry, which defeats
 * the guard entirely. The client must supply a stable ID per submission.
 */
export function fromWeb(payload: unknown): InboundMessage[] {
  const p = payload as WebPayload;

  const id = p.submissionId;
  const text = (p.message ?? "").trim();

  if (!id) throw new UnsupportedPayload("web", "no submissionId");
  if (!text) return [];

  return [
    {
      channel: "web",
      external_id: `web:${id}`,
      // Falls back to the session when no contact was given — an anonymous
      // report is still a report, and refusing it would be the wrong call.
      from: p.contact ?? p.sessionId ?? id,
      text,
      sent_at: p.submittedAt ?? new Date().toISOString(),
      speaker: "caller",
    },
  ];
}

/* ------------------------------------------------------------------ *
 * Dispatch
 * ------------------------------------------------------------------ */

const ADAPTERS: Partial<Record<IntakeChannel, (payload: unknown) => InboundMessage[]>> = {
  whatsapp: fromWhatsApp,
  sms: fromSms,
  web: fromWeb,
};

export function normaliseInbound(
  channel: IntakeChannel,
  payload: unknown,
): InboundMessage[] {
  const adapter = ADAPTERS[channel];
  if (!adapter) {
    throw new UnsupportedPayload(channel, "no adapter registered for this channel");
  }
  return adapter(payload);
}
