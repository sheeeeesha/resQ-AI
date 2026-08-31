# ResQ AI

## Register

**Product.** Design serves the task. The console is a tool a call-taker uses under
time pressure, not a surface that needs to impress. Familiarity is a feature;
the interface should disappear into the work.

## What this is

An AI triage layer for Indian emergency response (ERSS-112). Emergencies arrive
by WhatsApp, SMS, web and — from M5 — voice. The system classifies them,
resolves a location, and recommends response units. **A human confirms
everything before a vehicle moves.**

The console is where that human works.

## Who uses it

Emergency call-takers on a 24/7 control-room floor. Dim ambient light, long
shifts, several monitors, night shifts as busy as day. They are fast, trained,
and under continuous load. They are not analysts; they are triaging, and every
second of interface friction is a second of someone's emergency.

Their job on any given screen: **decide whether the machine got it right, and
fix it if not.** Everything else the interface does is in service of that.

## What the interface must do

1. **Distinguish machine judgement from human judgement, instantly.** An
   AI-proposed classification and an operator-confirmed one must never look
   alike. The operator has to know at a glance what they are still responsible
   for checking.

2. **Make escalation impossible to miss.** An escalated incident is one the
   system is explicitly saying it cannot handle alone. That must survive a
   glance across a room, not require reading.

3. **Show uncertainty honestly.** Confidence and evidence are visible on every
   extracted field. A field with no supporting transcript segment must look
   weaker than one with three.

4. **Never present a guess as a fact.** An unresolved location shows its
   candidates and its ambiguity. It does not pick one and render it as *the*
   location.

## Anti-references

**The prototype this replaces.** It rendered "Unknown" for most fields with no
indication of why, no confidence, no evidence, and no way to tell an AI guess
from a confirmed value. It also wrote to the database straight from the browser.
Both failures are structural, and the console is the place the first one shows.

**SaaS analytics dashboards.** Big hero metrics, sparklines, KPI cards, "12%
↑ this week". Nothing here is a metric to admire. Every number on screen is a
decision input for something happening right now.

**Alarm-panel aesthetics.** Red chrome, flashing borders, sirens-as-decoration.
Red that appears in headers and buttons is red that no longer means anything
when a P0 arrives. See the colour rule in DESIGN.md.

## Design principles

**Colour is data, not decoration.** Saturated hue means a status value —
priority, availability, review state. Chrome and surfaces stay near-neutral.
The consequence: when a call-taker sees red, it means exactly one thing.

**Status never relies on colour alone.** Around 8% of men have a colour vision
deficiency, and this is a public-service tool. Every status carries a second
channel — a code, a shape, a position, a word.

**Density is correct.** Call-takers want more on screen, not less. Whitespace
that costs a scroll costs time. This is a place for tables, not cards.

**The interface states what it does not know.** A blank field and an unanswered
question are different things and must look different.

## Accessibility

Body text at 4.5:1 minimum against its surface; status colours verified at 3:1
as large text and never load-bearing on their own. Full keyboard operation —
a call-taker's hands should not need to leave the keyboard to confirm a field.
Focus visible at all times, never suppressed.
