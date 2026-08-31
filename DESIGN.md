# ResQ AI Console — design system

## Theme

**Dark, committed.** Not a preference and not a toggle. A 24/7 control room runs
dim, shifts run twelve hours, and a bright surface at 3am over a long shift is
genuinely painful. Every real dispatch and NOC floor is dark for this reason.

There is no light mode. Building one would double the contrast surface to verify
for a deployment environment that does not exist.

## The colour rule

The rule everything else follows:

> **Chroma encodes whether something is data.**

- **Chroma below 0.03** — chrome. Surfaces, panels, borders, body text. Reads as
  neutral slate.
- **Chroma above 0.10** — data. Priority, availability, review state, escalation.
- **The violet accent** — interaction only. Selection, focus, primary action.

Violet because it is the one hue emergency semantics has not already claimed.
Red is P0. Amber is warning. Green is an available unit. Blue is police and
informational. A brand colour drawn from any of those would compete with the
data every time it appeared, and the data has to win.

The consequence, which is the point: **red appears on this screen only when
something is immediately life-threatening.** Not in headers, not on buttons, not
as a border flourish. A call-taker who sees red has learned it means one thing.

## Palette

All values OKLCH.

### Chrome

| Token | Value | Use |
|---|---|---|
| `--bg` | `oklch(0.17 0.012 265)` | Application ground |
| `--surface` | `oklch(0.21 0.014 265)` | Panels, table rows |
| `--surface-raised` | `oklch(0.25 0.016 265)` | Hover, selected row, inputs |
| `--border` | `oklch(0.32 0.014 265)` | Dividers, input borders |
| `--border-strong` | `oklch(0.42 0.016 265)` | Focused inputs, emphasis |
| `--ink` | `oklch(0.96 0.004 265)` | Primary text — 13.9:1 on `--bg` |
| `--ink-muted` | `oklch(0.76 0.010 265)` | Secondary text — 6.4:1 on `--bg` |
| `--ink-faint` | `oklch(0.62 0.012 265)` | Labels, timestamps — 4.6:1 on `--bg` |

`--ink-faint` sits at 4.6:1 deliberately: it is the floor, not a decorative
grey. Nothing readable goes below it. The single most common failure in dark
UI is muted text that drifts to 3:1 "for elegance", and this is a tool people
read for twelve hours.

### Interaction

| Token | Value | Use |
|---|---|---|
| `--accent` | `oklch(0.62 0.19 295)` | Primary action, selection, focus ring |
| `--accent-hover` | `oklch(0.68 0.19 295)` | Hover on accent surfaces |
| `--accent-muted` | `oklch(0.32 0.09 295)` | Selected row background |
| `--accent-ink` | `oklch(0.99 0.005 295)` | Text on accent — 7.1:1 |

### Priority — ordinal, and the only place red appears

| Token | Value | Meaning |
|---|---|---|
| `--p0` | `oklch(0.64 0.23 25)` | Immediate threat to life |
| `--p1` | `oklch(0.72 0.18 55)` | Urgent |
| `--p2` | `oklch(0.80 0.15 95)` | Prompt |
| `--p3` | `oklch(0.70 0.12 195)` | Routine |
| `--p4` | `oklch(0.62 0.03 265)` | Referral — deliberately near-neutral |

An ordinal ramp: hue rotates and chroma falls as urgency drops, so the sequence
reads as a sequence rather than five unrelated labels. P4 is nearly chrome
because a referral is not a status anyone should be drawn to.

**Never used alone.** Every priority renders its code (`P0`) alongside its
colour, and the queue is sorted by it. Colour is the third channel, not the
first.

### Status

| Token | Value | Meaning |
|---|---|---|
| `--ok` | `oklch(0.72 0.16 150)` | Unit available, field confirmed |
| `--warn` | `oklch(0.78 0.15 75)` | Degraded, estimated, unconfirmed |
| `--danger` | `oklch(0.64 0.23 25)` | Same value as `--p0`, by design |

`--danger` and `--p0` being one value is intentional. Two reds that differ
slightly is how a palette teaches people to stop reading red carefully.

## Provenance — the load-bearing distinction

An AI proposal and a human decision must never be confusable. Colour alone
cannot carry this, because it is already carrying priority.

**AI-proposed** — dashed left-to-right underline beneath the value, `--ink-muted`
text, confidence shown numerically. The value looks provisional because it is.

**Human-confirmed** — solid text at `--ink`, a check glyph, operator ID on hover.
No underline. It reads as settled.

**Human-corrected** — as confirmed, plus the superseded value struck through
beside it, so the correction stays visible rather than erasing history.

**Unclear / not stated** — the word, in `--ink-faint`, in italic. Never an empty
cell. A blank looks like a rendering bug; "not stated" is information.

The distinction is texture and weight, not hue, so it survives both colour
vision deficiency and a monochrome printout of a handoff sheet.

## Typography

**One family.** `ui-sans-serif` / Inter stack for everything — headings, labels,
data. Product UI does not need a display pairing, and a second family here would
be decoration competing with information.

**One exception:** `ui-monospace` for incident references, coordinates, Plus
Codes and unit IDs. Those are identifiers a call-taker reads aloud, digit by
digit, over radio. Tabular figures stop `1` and `7` from shifting column
position between rows.

Fixed rem scale, ratio 1.2. No fluid clamps — users are at consistent DPI on
fixed monitors, and a heading that resizes with a panel looks broken, not
responsive.

| Step | Size | Use |
|---|---|---|
| `--text-xs` | 0.75rem | Labels, timestamps, metadata |
| `--text-sm` | 0.8125rem | Table body, dense data |
| `--text-base` | 0.9375rem | Body, transcript |
| `--text-lg` | 1.125rem | Panel headings |
| `--text-xl` | 1.375rem | Incident reference |

## Layout

Three columns on a control-room monitor: **queue** (fixed 380px) · **incident
detail** (fluid) · **transcript** (fixed 420px). Below 1280px the transcript
moves under the detail; below 900px the queue becomes a drawer.

Structural responsiveness only. Nothing fluid-scales.

## Motion

150–200ms, ease-out. Motion conveys state change and nothing else: a row
arriving in the queue, a field settling after confirmation, a panel opening.

**No entrance choreography.** The console loads into a task. A new P0 arriving
gets a brief highlight decay so a call-taker who glanced away sees that
something changed — that is motion carrying information, and it is the only
attention-seeking movement in the interface.

`prefers-reduced-motion` replaces every transition with an instant state change.

## Bans, specific to this console

- **Red as chrome.** No red borders, headers, buttons or accents. Red is P0.
- **Cards for incidents.** The queue is a table. Cards cost vertical space a
  call-taker pays for in scrolling.
- **Spinners over content.** Skeleton rows. A spinner where data should be tells
  an operator nothing about what is arriving.
- **Toasts for anything that matters.** A confirmation that disappears after
  four seconds is not a record. State changes show in place.
- **Empty cells.** Every absent value says why it is absent.
