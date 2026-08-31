import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Request authentication.
 *
 * The prototype exposed `/store-transcript` and `/process-completed-call` with
 * no authentication at all — anyone who found the URL could inject fabricated
 * emergencies or drain the API budget. Every write path here is authenticated,
 * and the two kinds of caller need different mechanisms:
 *
 *  - **Providers** (WhatsApp, Twilio) sign their payloads. We verify the
 *    signature against the raw bytes.
 *  - **Operators** present a bearer token. Interim — real identity, roles and
 *    session handling arrive in M7 — but a named operator on every override is
 *    required from the start, because the override trail is worthless if it
 *    cannot say who overrode.
 */

/**
 * Constant-time comparison of two strings.
 *
 * `===` on a signature leaks its prefix through timing. The length check
 * before `timingSafeEqual` is unavoidable — that function throws on mismatched
 * lengths — but a signature's length is not the secret.
 */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/* ------------------------------------------------------------------ *
 * WhatsApp Cloud API
 * ------------------------------------------------------------------ */

export interface SignatureResult {
  valid: boolean;
  reason?: string;
}

/**
 * Verifies Meta's `X-Hub-Signature-256` header.
 *
 * Computed over the **raw request body**, not a re-serialisation of the parsed
 * JSON. `JSON.stringify(JSON.parse(body))` is not byte-identical to `body` —
 * key order, whitespace and unicode escaping all differ — so verifying against
 * re-serialised JSON fails for legitimate requests and tempts whoever debugs it
 * into disabling the check. The raw bytes have to be preserved at the parser.
 */
export function verifyWhatsAppSignature(
  rawBody: Buffer,
  header: string | undefined,
  appSecret: string,
): SignatureResult {
  if (!header) return { valid: false, reason: "missing X-Hub-Signature-256" };

  const [scheme, provided] = header.split("=");
  if (scheme !== "sha256" || !provided) {
    return { valid: false, reason: "malformed signature header" };
  }

  const expected = createHmac("sha256", appSecret).update(rawBody).digest("hex");

  return safeEqual(provided, expected)
    ? { valid: true }
    : { valid: false, reason: "signature mismatch" };
}

/**
 * Meta's webhook verification handshake.
 *
 * Meta issues a GET with a challenge when the webhook is first registered, and
 * expects the challenge echoed back verbatim — as plain text, not JSON.
 */
export function verifyWhatsAppChallenge(
  query: Record<string, unknown>,
  verifyToken: string,
): { ok: boolean; challenge?: string } {
  const mode = query["hub.mode"];
  const token = query["hub.verify_token"];
  const challenge = query["hub.challenge"];

  if (
    mode === "subscribe" &&
    typeof token === "string" &&
    safeEqual(token, verifyToken) &&
    typeof challenge === "string"
  ) {
    return { ok: true, challenge };
  }
  return { ok: false };
}

/* ------------------------------------------------------------------ *
 * Twilio
 * ------------------------------------------------------------------ */

/**
 * Verifies Twilio's `X-Twilio-Signature`.
 *
 * A different scheme from Meta's: HMAC-SHA1 over the full request URL with the
 * POST parameters appended in lexicographic key order, base64-encoded.
 *
 * The URL must be exactly what Twilio called, including scheme, host and query
 * string. Behind a proxy that terminates TLS, the URL Node sees is `http://`
 * while Twilio signed `https://` — so the public URL is configured rather than
 * reconstructed from the request, which would silently fail in exactly the
 * deployment that matters.
 */
export function verifyTwilioSignature(
  publicUrl: string,
  params: Record<string, string>,
  header: string | undefined,
  authToken: string,
): SignatureResult {
  if (!header) return { valid: false, reason: "missing X-Twilio-Signature" };

  const payload = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], publicUrl);

  const expected = createHmac("sha1", authToken).update(payload).digest("base64");

  return safeEqual(header, expected)
    ? { valid: true }
    : { valid: false, reason: "signature mismatch" };
}

/* ------------------------------------------------------------------ *
 * Operators
 * ------------------------------------------------------------------ */

export interface Operator {
  id: string;
}

/**
 * Bearer-token operator identity.
 *
 * Interim by design. Real authentication — sessions, roles, revocation, an
 * identity provider — is M7 work. What cannot wait is the *identity*: every
 * override records who made it, and the override rate broken down by operator
 * is a quality signal we lose forever if it is not captured at the time.
 *
 * Tokens are supplied as `token:operatorId` pairs. Comparison is constant-time
 * and the token itself is never logged.
 */
export class OperatorRegistry {
  private readonly byToken = new Map<string, Operator>();

  constructor(spec: string | undefined) {
    for (const entry of (spec ?? "").split(",")) {
      const trimmed = entry.trim();
      if (!trimmed) continue;

      const separator = trimmed.lastIndexOf(":");
      if (separator <= 0) continue;

      const token = trimmed.slice(0, separator);
      const id = trimmed.slice(separator + 1);
      if (token && id) this.byToken.set(token, { id });
    }
  }

  get size(): number {
    return this.byToken.size;
  }

  /** Resolves an `Authorization: Bearer …` header to an operator. */
  resolve(header: string | undefined): Operator | null {
    if (!header?.startsWith("Bearer ")) return null;
    const presented = header.slice("Bearer ".length).trim();
    if (!presented) return null;

    // Compare against every token rather than a map lookup, so response time
    // does not reveal whether a prefix matched a real token.
    let found: Operator | null = null;
    for (const [token, operator] of this.byToken) {
      if (safeEqual(presented, token)) found = operator;
    }
    return found;
  }
}

/* ------------------------------------------------------------------ *
 * Rate limiting
 * ------------------------------------------------------------------ */

/**
 * A fixed-window counter, in memory.
 *
 * Deliberately small: it exists to stop a misbehaving client or a trivial flood
 * from running up an LLM bill, not to defend against a distributed attack. It
 * does not survive a restart and does not coordinate across instances — a
 * shared limiter belongs with the durable-execution work in M7.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Returns true when the request is allowed. */
  check(key: string, now = Date.now()): boolean {
    const entry = this.hits.get(key);

    if (!entry || now >= entry.resetAt) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      this.sweep(now);
      return true;
    }

    entry.count += 1;
    return entry.count <= this.limit;
  }

  /** Drops expired windows so the map cannot grow without bound. */
  private sweep(now: number): void {
    if (this.hits.size < 1000) return;
    for (const [key, entry] of this.hits) {
      if (now >= entry.resetAt) this.hits.delete(key);
    }
  }
}
