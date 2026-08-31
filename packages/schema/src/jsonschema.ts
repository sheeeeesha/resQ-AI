import { z } from "zod";
import { IncidentExtraction, MedicalSupplement } from "./extraction.js";

/**
 * JSON Schema generation for constrained decoding.
 *
 * Providers differ in what subset of JSON Schema they accept, and the
 * differences are not cosmetic — several reject `$ref`, several require every
 * property to be listed as required, and several silently ignore keywords they
 * do not understand, which is worse than rejecting them. The helpers here
 * normalise a Zod schema into the conservative intersection that works across
 * Gemini, OpenAI and open-weight constrained decoders such as Outlines or
 * llama.cpp grammars.
 */

type JsonSchema = Record<string, unknown>;

/**
 * Inlines every `$ref` and drops the `$defs` block.
 *
 * Zod hoists repeated shapes into `$defs` — and `extractedField` is used a
 * dozen times, so it always hoists. Gemini's structured-output subset does not
 * resolve `$ref`, so the schema has to be flattened before it is sent.
 *
 * Our schemas are finite and acyclic by construction, so a straightforward
 * recursive expansion terminates. The depth guard is a backstop against a
 * future edit introducing a cycle, not a expected condition.
 */
function inlineRefs(schema: JsonSchema): JsonSchema {
  const defs = (schema.$defs ?? schema.definitions ?? {}) as Record<
    string,
    JsonSchema
  >;

  const expand = (node: unknown, depth: number): unknown => {
    if (depth > 50) {
      throw new Error(
        "inlineRefs exceeded depth 50 — the schema may contain a cycle",
      );
    }
    if (Array.isArray(node)) {
      return node.map((n) => expand(n, depth + 1));
    }
    if (node && typeof node === "object") {
      const obj = node as JsonSchema;

      const ref = obj.$ref;
      if (typeof ref === "string") {
        const key = ref.replace(/^#\/(\$defs|definitions)\//, "");
        const target = defs[key];
        if (!target) {
          throw new Error(`inlineRefs could not resolve $ref: ${ref}`);
        }
        // Merge any sibling keywords over the expanded target.
        const { $ref: _drop, ...siblings } = obj;
        return {
          ...(expand(target, depth + 1) as JsonSchema),
          ...(expand(siblings, depth + 1) as JsonSchema),
        };
      }

      const out: JsonSchema = {};
      for (const [k, v] of Object.entries(obj)) {
        if (k === "$defs" || k === "definitions") continue;
        out[k] = expand(v, depth + 1);
      }
      return out;
    }
    return node;
  };

  return expand(schema, 0) as JsonSchema;
}

/**
 * Marks every object property required and forbids extra properties.
 *
 * Strict decoders require this. It is also what we want semantically: a field
 * the model may omit is a field the model will omit under pressure, and an
 * absent field is indistinguishable from an unanswerable one. Every field in
 * the extraction contract can already express "I don't know" through its
 * `status` — so there is never a legitimate reason to leave one out.
 */
function enforceStrict(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(enforceStrict);
  }
  if (node && typeof node === "object") {
    const obj = { ...(node as JsonSchema) };

    for (const [k, v] of Object.entries(obj)) {
      obj[k] = enforceStrict(v);
    }

    if (obj.type === "object" && obj.properties) {
      obj.required = Object.keys(obj.properties as JsonSchema);
      obj.additionalProperties = false;
    }
    return obj;
  }
  return node;
}

/**
 * Strips keywords that constrained decoders commonly reject or ignore.
 *
 * Numeric bounds and string patterns are the usual casualties. We keep them in
 * the Zod schema, where they are enforced at validation time, and remove them
 * from the grammar rather than have a provider reject the whole request over
 * an unsupported keyword.
 */
const UNSUPPORTED_KEYWORDS = [
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "patternProperties",
  "dependentSchemas",
  "$schema",
  "$id",
  "default",
];

function stripUnsupported(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripUnsupported);
  if (node && typeof node === "object") {
    const out: JsonSchema = {};
    for (const [k, v] of Object.entries(node as JsonSchema)) {
      if (UNSUPPORTED_KEYWORDS.includes(k)) continue;
      out[k] = stripUnsupported(v);
    }
    return out;
  }
  return node;
}

/** Raw JSON Schema for a Zod schema, refinements omitted. */
export function toJsonSchema(schema: z.ZodType): JsonSchema {
  return z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io: "input",
    unrepresentable: "any",
  }) as JsonSchema;
}

/**
 * Provider-ready schema: refs inlined, all properties required, extras
 * forbidden, unsupported keywords removed.
 */
export function toStrictJsonSchema(schema: z.ZodType): JsonSchema {
  return enforceStrict(
    stripUnsupported(inlineRefs(toJsonSchema(schema))),
  ) as JsonSchema;
}

/* ------------------------------------------------------------------ *
 * Prebuilt contracts
 * ------------------------------------------------------------------ */

/**
 * Built once at module load rather than per request. These are sent on every
 * extraction pass during a live call, and regenerating them per call would
 * add avoidable latency on the one path where latency is measured in lives.
 */
export const INCIDENT_EXTRACTION_JSON_SCHEMA =
  toStrictJsonSchema(IncidentExtraction);

export const MEDICAL_SUPPLEMENT_JSON_SCHEMA =
  toStrictJsonSchema(MedicalSupplement);

/**
 * Version stamp for the extraction contract.
 *
 * Recorded on every `ExtractionResult`. When the schema changes, this changes,
 * and stored records remain interpretable against the contract that produced
 * them — which is the difference between an audit trail and a pile of JSON.
 */
export const EXTRACTION_CONTRACT_VERSION = "1.0.0";
