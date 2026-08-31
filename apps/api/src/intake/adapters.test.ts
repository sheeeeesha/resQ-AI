import test from "node:test";
import assert from "node:assert/strict";
import {
  fromSms,
  fromWeb,
  fromWhatsApp,
  hashCallerId,
  normaliseInbound,
  normaliseSpeaker,
  UnsupportedPayload,
} from "./adapters.js";

const SALT = "a".repeat(32);

/* ------------------------------------------------------------------ *
 * Speaker roles
 * ------------------------------------------------------------------ */

test("vendor speaker labels map onto our roles", () => {
  assert.equal(normaliseSpeaker("caller"), "caller");
  assert.equal(normaliseSpeaker("user"), "caller");
  assert.equal(normaliseSpeaker("inbound"), "caller");
  assert.equal(normaliseSpeaker("assistant"), "ai_agent");
  assert.equal(normaliseSpeaker("bot"), "ai_agent");
  assert.equal(normaliseSpeaker("operator"), "call_taker");
  assert.equal(normaliseSpeaker("AGENT"), "call_taker");
});

test("an unrecognised speaker label becomes unknown, never caller", () => {
  // The prototype filtered on the literal string "caller" and would have
  // matched nothing against a user/assistant feed — returning Neutral for
  // every call while appearing to work. Defaulting to `caller` here would
  // reintroduce that class of silent corruption in the other direction.
  assert.equal(normaliseSpeaker("participant_1"), "unknown");
  assert.equal(normaliseSpeaker(undefined), "unknown");
  assert.equal(normaliseSpeaker(null), "unknown");
  assert.equal(normaliseSpeaker(""), "unknown");
});

/* ------------------------------------------------------------------ *
 * Caller identity
 * ------------------------------------------------------------------ */

test("Indian numbers in any common form hash to the same identity", () => {
  const forms = ["+91 98765 43210", "919876543210", "09876543210", "9876543210"];
  const hashes = forms.map((f) => hashCallerId(f, SALT));

  // A caller messaging twice from the same phone must resolve to the same
  // open incident regardless of how the gateway formatted the number.
  assert.equal(new Set(hashes).size, 1, `expected one identity, got ${hashes.join(", ")}`);
});

test("different numbers hash differently, and the raw number never appears", () => {
  const a = hashCallerId("9876543210", SALT);
  const b = hashCallerId("9876543211", SALT);

  assert.notEqual(a, b);
  assert.ok(!a.includes("9876543210"));
  assert.match(a, /^h1:[0-9a-f]{32}$/);
});

test("the salt changes the hash", () => {
  assert.notEqual(
    hashCallerId("9876543210", SALT),
    hashCallerId("9876543210", "b".repeat(32)),
  );
});

/* ------------------------------------------------------------------ *
 * WhatsApp
 * ------------------------------------------------------------------ */

function whatsAppPayload(messages: unknown[]) {
  return { entry: [{ changes: [{ value: { messages } }] }] };
}

test("a WhatsApp text message normalises", () => {
  const [msg] = fromWhatsApp(
    whatsAppPayload([
      {
        id: "wamid.ABC123",
        from: "919876543210",
        timestamp: "1756543200",
        type: "text",
        text: { body: "aag lag gayi hai" },
      },
    ]),
  );

  assert.equal(msg!.channel, "whatsapp");
  assert.equal(msg!.external_id, "whatsapp:wamid.ABC123");
  assert.equal(msg!.text, "aag lag gayi hai");
  // Direction settles the role — no vendor label is consulted, so none can be wrong.
  assert.equal(msg!.speaker, "caller");
  assert.equal(msg!.sent_at, new Date(1756543200 * 1000).toISOString());
});

test("one webhook carrying several messages yields several", () => {
  const msgs = fromWhatsApp(
    whatsAppPayload([
      { id: "m1", from: "91987", timestamp: "1756543200", type: "text", text: { body: "help" } },
      { id: "m2", from: "91987", timestamp: "1756543210", type: "text", text: { body: "near ORR" } },
    ]),
  );
  assert.equal(msgs.length, 2);
});

test("non-text WhatsApp messages are dropped, not silently blanked", () => {
  const msgs = fromWhatsApp(
    whatsAppPayload([
      { id: "m1", from: "91987", timestamp: "1756543200", type: "image" },
      { id: "m2", from: "91987", timestamp: "1756543201", type: "location" },
    ]),
  );
  // Images and location are real and useful; they belong to a later milestone.
  // Passing them through as empty text would put silent blanks in the transcript.
  assert.equal(msgs.length, 0);
});

test("a WhatsApp message missing its id is rejected", () => {
  assert.throws(
    () =>
      fromWhatsApp(
        whatsAppPayload([{ from: "91987", type: "text", text: { body: "hi" } }]),
      ),
    UnsupportedPayload,
  );
});

/* ------------------------------------------------------------------ *
 * SMS and web
 * ------------------------------------------------------------------ */

test("a Twilio-shaped SMS normalises", () => {
  const [msg] = fromSms({
    MessageSid: "SM123",
    From: "+919876543210",
    Body: "accident on the highway",
  });

  assert.equal(msg!.external_id, "sms:SM123");
  assert.equal(msg!.channel, "sms");
  assert.equal(msg!.speaker, "caller");
});

test("a web submission requires a client-supplied id", () => {
  // Minting one server-side would differ on every retry, defeating the
  // idempotency guard entirely.
  assert.throws(() => fromWeb({ message: "help" }), UnsupportedPayload);
});

test("an anonymous web report is accepted", () => {
  const [msg] = fromWeb({
    submissionId: "sub-1",
    sessionId: "sess-9",
    message: "building collapsed",
  });
  assert.equal(msg!.from, "sess-9");
  assert.equal(msg!.text, "building collapsed");
});

test("an empty message body produces nothing rather than a blank segment", () => {
  assert.equal(fromSms({ MessageSid: "S1", From: "+91987", Body: "   " }).length, 0);
  assert.equal(fromWeb({ submissionId: "s1", message: "" }).length, 0);
});

/* ------------------------------------------------------------------ *
 * Dispatch
 * ------------------------------------------------------------------ */

test("an unregistered channel is refused rather than guessed at", () => {
  assert.throws(() => normaliseInbound("iot_signal", {}), UnsupportedPayload);
});
