# @resqai/schema

The shared contract between intake, extraction, the dispatch console and storage.
Backend and frontend both import from here; nothing re-declares these shapes locally.

```bash
npm install && npm run build && npm test
```

## The five modules

| Module | Holds |
| --- | --- |
| `enums.ts` | Closed vocabularies — agencies, priority, incident types, hazards, languages, lifecycle |
| `field.ts` | The field envelope and confidence gating |
| `transcript.ts` | Segments with per-segment ASR confidence, quality assessment |
| `extraction.ts` | What the model may emit, plus post-decode semantic validation |
| `incident.ts` | The stored record: proposals, review state, resolved location, units, audit |
| `jsonschema.ts` | Provider-ready JSON Schema for constrained decoding |

## Three decisions worth knowing

**Every AI value is wrapped, never bare.** Indic ASR runs at 22–30% WER on
telephony audio and ~42% on code-switched speech. A pipeline built on text that
wrong cannot emit bare values and stay honest, so every field carries
`{ value, status, confidence, evidence }`. `status` separates *the caller never
said this* from *something was said but we could not resolve it* — the only
signal that tells a call-taker whether to ask again.

**Shape is constrained at decode time; sense is checked after.** The JSON Schema
makes malformed output physically impossible. Semantic contradictions — a
`P0_immediate` asserted at 0.2 confidence, a people range whose min exceeds its
max — are caught by `validateSemantics` afterwards, where we can log and recover.
Pushing semantics into the grammar makes the grammar large and the model worse.

**Priority is an ordered code, not a word.** The prototype's
`orderBy("criticality", "desc")` over `High`/`Medium`/`Low` sorted to
Medium → Low → High, putting the most critical incidents last. `P0`–`P4` makes
that class of bug unrepresentable; there is a test asserting exactly this.

## Using it

```ts
import {
  INCIDENT_EXTRACTION_JSON_SCHEMA,
  IncidentExtraction,
  validateSemantics,
  isRoutable,
} from "@resqai/schema";

// 1. Constrain the model to the contract.
const raw = await model.generate({ responseSchema: INCIDENT_EXTRACTION_JSON_SCHEMA });

// 2. Parse. Shape is already guaranteed; this catches transport damage.
const core = IncidentExtraction.parse(raw);

// 3. Check sense, and log rather than throw — on a live call a partial
//    extraction beats no extraction.
const problems = validateSemantics(core);

// 4. Gate on confidence before anything automated happens.
if (isRoutable(core.incident_type)) { /* … */ }
```

Note `renderForExtraction()` in `transcript.ts`: it numbers segments so the model
can cite them as evidence, and marks low-confidence spans inline so the model can
down-weight them. Telling the model where the audio was bad is the cheapest
accuracy improvement available on this path.
