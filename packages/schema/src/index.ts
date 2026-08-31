/**
 * @resqai/schema
 *
 * The shared contract between intake, extraction, the dispatch console and
 * storage. Both the backend and the frontend import from here; nothing
 * re-declares these shapes locally.
 */

export * from "./enums.js";
export * from "./field.js";
export * from "./transcript.js";
export * from "./extraction.js";
export * from "./incident.js";
export * from "./jsonschema.js";

export * from "./triage.js";
export * from "./eval.js";
