/**
 * Structural validation for Zarr metadata documents.
 *
 * A faithful port of `zarr_metadata.model._validation` (the Python reference
 * implementation). Validators check JSON structure (key presence, value
 * shapes, and fixed literals like `zarr_format`), not domain validity. Each
 * concept gets a `validate*` function returning every problem found, an
 * `is*` type guard, and a `parse*` function that narrows or throws
 * `MetadataValidationError`.
 *
 * Two Python behaviors have no JS analog and are intentionally absent:
 *
 * - tuple-vs-list canonicalization (`arrays_to_tuples`): JSON arrays are
 *   plain arrays in JS, so there is nothing to normalize;
 * - int-vs-float literal spelling (`zarr_format: 3.0` vs `3`): `JSON.parse`
 *   collapses both to the number `3`, so JS cannot reject the float
 *   spelling. The shared conformance corpus avoids fixtures that hinge on
 *   this distinction.
 *
 * Python ints are unbounded; the JS analog is `bigint`. `decodeStoreJson`
 * keeps integer literals beyond `Number.MAX_SAFE_INTEGER` exact as bigints
 * (bare `JSON.parse` rounds them, so e.g. an out-of-range int64 fill value
 * becomes indistinguishable from a valid one), and every validator accepts a
 * bigint wherever it accepts an integer.
 *
 * Three behaviors are deliberate TS-side hardening divergences:
 *
 * - a "mapping" means a plain object (prototype `null` or
 *   `Object.prototype`). Python accepts any `Mapping`; here `Date`, `Map`,
 *   `Set`, and class instances are rejected as non-JSON rather than
 *   validated as empty objects and mis-serialized later. Unobservable for
 *   `JSON.parse` output;
 * - an array must be dense with index-only own properties: holes (which
 *   `every`/`forEach` would silently skip) and extra own properties like a
 *   `toJSON` method (which `JSON.stringify` would honor, serializing
 *   something other than what was validated) are rejected. Unobservable
 *   for `JSON.parse` output;
 * - containers (and the group ↔ consolidated-metadata document recursion)
 *   nested deeper than `MAX_JSON_DEPTH` are reported as a problem instead
 *   of overflowing the stack. This one IS observable for JSON text —
 *   `JSON.parse` accepts documents nested past the cap, where Python
 *   reports no problem (or raises `RecursionError` far deeper) — so the
 *   corpus must never contain fixtures that exceed the cap.
 */

import type { JSONValue, ZarrV3MetadataFieldJSON } from "./common.js";
import {
  MetadataValidationError,
  treeOf,
  type ErrorTree,
  type IssueKind,
  type IssuePath,
  type ParseResult,
  type PathedIssue,
} from "./errors.js";
import {
  ARRAY_METADATA_REQUIRED_KEYS_V2,
  ZARR_V2_ARRAY_DIMENSION_SEPARATOR,
  ZARR_V2_ARRAY_ORDER,
  GROUP_METADATA_REQUIRED_KEYS_V2,
  GROUP_METADATA_STANDARD_KEYS_V2,
  type ZarrV2ArrayMetadataJSON,
  type ZarrV2ConsolidatedMetadataJSON,
  type ZarrV2GroupMetadataJSON,
} from "./v2.js";
import {
  ARRAY_METADATA_REQUIRED_KEYS_V3,
  ARRAY_METADATA_STANDARD_KEYS_V3,
  GROUP_METADATA_REQUIRED_KEYS_V3,
  GROUP_METADATA_STANDARD_KEYS_V3,
  ZARR_V3_CONSOLIDATED_METADATA_KEY,
  type ZarrV3ArrayMetadataJSON,
  type ZarrV3ConsolidatedMetadataJSON,
  type ZarrV3GroupMetadataJSON,
  type ZarrV3MetadataJSON,
} from "./v3.js";

// Validators internally accumulate flat pathed issues (cheap to emit and to
// prefix while recursing); the public functions assemble them into the
// ErrorTree consumers see.
function problem(path: IssuePath, message: string, kind: IssueKind): PathedIssue {
  return { path, message, kind };
}

function prefix(head: string | number, issues: PathedIssue[]): PathedIssue[] {
  return issues.map((issue) => ({ ...issue, path: [head, ...issue.path] }));
}

/**
 * Maximum container nesting depth accepted by `validateJson` (and, through
 * it, every document validator) before validation reports a problem instead
 * of recursing further. Mirrors `zarr.core.json_parse.MAX_JSON_DEPTH`; no
 * real metadata document approaches it. The cap also terminates validation
 * of circular object graphs.
 */
export const MAX_JSON_DEPTH = 64;

/**
 * Whether `value` is a plain object: prototype `null` or `Object.prototype`.
 *
 * The mapping notion for every validator. Stricter than `typeof "object"`
 * on purpose: `Date`, `Map`, `Set`, and class instances have no own
 * enumerable JSON content, so treating them as mappings would validate an
 * empty object and then serialize something else entirely.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

/** Whether `doc` has `key` as an OWN property (`in` would consult the prototype). */
function has(doc: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(doc, key);
}

/**
 * Whether `value` is a dense array whose own enumerable keys are exactly its
 * indices.
 *
 * The array notion for every validator. Holes would be silently skipped by
 * `every`/`forEach` (validating elements nobody looked at), and extra own
 * properties — an own `toJSON` above all — would make `JSON.stringify` emit
 * something other than what was validated. Both are impossible in
 * `JSON.parse` output and rejected here.
 */
function isDenseArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === value.length && keys.every((key, index) => key === String(index));
}

function show(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "bigint") return `${value}n`;
  try {
    const rendered = JSON.stringify(value);
    return rendered === undefined ? String(value) : rendered;
  } catch {
    // JSON.stringify can throw (e.g. a BigInt nested in a container); the
    // renderer must never fail on the values it exists to describe.
    return String(value);
  }
}

/** Return every reason `value` is not JSON-serializable (recursively). */
function jsonProblems(value: unknown): PathedIssue[] {
  return validateJsonAtDepth(value, 0);
}

function validateJsonAtDepth(value: unknown, depth: number): PathedIssue[] {
  if (typeof value === "bigint") return [];
  if (typeof value === "number") {
    if (Number.isFinite(value)) return [];
    return [problem([], `non-finite number ${value} is not JSON`, "invalid_value")];
  }
  if (typeof value === "string" || typeof value === "boolean" || value === null) {
    return [];
  }
  const problems: PathedIssue[] = [];
  if (Array.isArray(value)) {
    if (depth >= MAX_JSON_DEPTH) {
      return [problem([], `maximum nesting depth of ${MAX_JSON_DEPTH} exceeded`, "invalid_value")];
    }
    if (!isDenseArray(value)) {
      return [
        problem([], "array has holes or non-index own properties", "invalid_type"),
      ];
    }
    value.forEach((item, index) => {
      problems.push(...prefix(index, validateJsonAtDepth(item, depth + 1)));
    });
    return problems;
  }
  if (isPlainObject(value)) {
    if (depth >= MAX_JSON_DEPTH) {
      return [problem([], `maximum nesting depth of ${MAX_JSON_DEPTH} exceeded`, "invalid_value")];
    }
    for (const [key, item] of Object.entries(value)) {
      problems.push(...prefix(key, validateJsonAtDepth(item, depth + 1)));
    }
    return problems;
  }
  return [problem([], `not a JSON-serializable value: ${show(value)}`, "invalid_type")];
}


/** One `missing_key` problem per required key absent from `doc`. */
function missingKeys(
  required: ReadonlyArray<string>,
  doc: Record<string, unknown>,
): PathedIssue[] {
  return [...required]
    .filter((key) => !(has(doc, key)))
    .sort()
    .map((key) => problem([key], "missing required key", "missing_key"));
}

/** One problem per member outside a closed document's declared shape. */
function unexpectedKeys(
  allowed: ReadonlyArray<string>,
  doc: Record<string, unknown>,
): PathedIssue[] {
  return Object.keys(doc)
    .filter((key) => !allowed.includes(key))
    .map((key) => problem([key], "unexpected document member", "invalid_value"));
}

/** One `invalid_value` problem if `doc[key]` is present but not `expected`. */
function checkLiteral(
  doc: Record<string, unknown>,
  key: string,
  expected: string | number | boolean,
): PathedIssue[] {
  if (has(doc, key) && (typeof doc[key] !== typeof expected || doc[key] !== expected)) {
    return [
      problem([key], `expected ${show(expected)}, got ${show(doc[key])}`, "invalid_value"),
    ];
  }
  return [];
}

/** Validate v3 top-level unknown-field JSON payloads. */
function validateExtensionFieldsV3(
  doc: Record<string, unknown>,
  standardKeys: ReadonlyArray<string>,
  additionalReservedKeys: ReadonlyArray<string> = [],
): PathedIssue[] {
  const reserved = new Set([...standardKeys, ...additionalReservedKeys]);
  const problems: PathedIssue[] = [];
  for (const [key, value] of Object.entries(doc)) {
    if (reserved.has(key)) continue;
    problems.push(...prefix(key, jsonProblems(value)));
  }
  return problems;
}

/**
 * Return every reason `value` is not a v3 metadata field.
 *
 * A metadata field is a bare name string or an object containing `name` and
 * optional `configuration` and `must_understand` members.
 */
function metadataFieldV3Problems(
  value: unknown,
  options: { allowMustUnderstandFalse?: boolean } = {},
): PathedIssue[] {
  const { allowMustUnderstandFalse = true } = options;
  if (typeof value === "string") return [];
  if (!isPlainObject(value)) {
    return [
      problem([], "expected a metadata field (string or extension object)", "invalid_type"),
    ];
  }
  const problems: PathedIssue[] = [];
  const allowedKeys = new Set(["name", "configuration", "must_understand"]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      problems.push(problem([key], "unexpected metadata field member", "invalid_value"));
    }
  }
  if (typeof value["name"] !== "string") {
    problems.push(problem(["name"], "expected a string name", "invalid_type"));
  }
  if (has(value, "configuration")) {
    const configuration = value["configuration"];
    if (!isPlainObject(configuration)) {
      problems.push(problem(["configuration"], "expected a mapping", "invalid_type"));
    } else {
      for (const [key, item] of Object.entries(configuration)) {
        problems.push(...prefix("configuration", prefix(key, jsonProblems(item))));
      }
    }
  }
  if (has(value, "must_understand")) {
    const mustUnderstand = value["must_understand"];
    if (typeof mustUnderstand !== "boolean") {
      problems.push(problem(["must_understand"], "expected a boolean", "invalid_type"));
    } else if (!allowMustUnderstandFalse && !mustUnderstand) {
      problems.push(
        problem(
          ["must_understand"],
          "false is not supported at this extension point",
          "invalid_value",
        ),
      );
    }
  }
  return problems;
}


/**
 * Whether `value` is an array of integers (numbers or bigints).
 *
 * `Number.isInteger` rejects booleans, non-finite numbers, and non-integral
 * floats, mirroring the Python bool-is-not-int rule.
 */
function isIntSequence(value: unknown): value is (number | bigint)[] {
  return (
    isDenseArray(value) &&
    value.every((item) => typeof item === "bigint" || Number.isInteger(item))
  );
}

/**
 * Validate a dimension sequence (`shape` / `chunks`) if present in `doc`.
 * Dimension lengths are non-negative integers.
 */
function validateDimSequence(doc: Record<string, unknown>, key: string): PathedIssue[] {
  if (!(has(doc, key))) return [];
  const value = doc[key];
  if (!isIntSequence(value)) {
    return [problem([key], "expected a sequence of int", "invalid_type")];
  }
  if (value.some((item) => item < 0)) {
    return [problem([key], "expected non-negative integers", "invalid_value")];
  }
  return [];
}

/**
 * Whether `value` is shaped like a v2 dtype: a string or field records.
 *
 * A field record is a `[name, dtype]` or `[name, dtype, shape]` array, where
 * `dtype` is itself a string or nested field records and `shape` is an array
 * of int. The string content is NOT interpreted — whether the string names a
 * real dtype is domain validity, not structure.
 */
function isDtypeV2(value: unknown, depth = 0): boolean {
  if (typeof value === "string") return true;
  if (!isDenseArray(value)) return false;
  // A dtype nested past the depth cap is rejected wholesale rather than
  // recursed into; this is the same hardening rule as validateJson's.
  if (depth >= MAX_JSON_DEPTH) return false;
  for (const record of value) {
    if (typeof record === "string" || !isDenseArray(record)) return false;
    if (record.length !== 2 && record.length !== 3) return false;
    if (typeof record[0] !== "string") return false;
    if (!isDtypeV2(record[1], depth + 1)) return false;
    if (record.length === 3 && !isIntSequence(record[2])) return false;
  }
  return true;
}

/** Whether `value` is shaped like a v2 codec config: an object with a string `id`. */
function isCodecV2(value: unknown): boolean {
  return isPlainObject(value) && typeof value["id"] === "string";
}

/** Validate a v2 codec's required shape and JSON-valued configuration. */
function validateCodecV2(value: unknown): PathedIssue[] {
  if (!isCodecV2(value)) {
    return [problem([], "expected a codec configuration with a string 'id'", "invalid_type")];
  }
  return jsonProblems(value);
}

/**
 * Validate an `attributes` value: a JSON object.
 *
 * Unlike the other validators (which return value-relative locs for the
 * caller to prefix), this emits the already-parent-relative `["attributes"]`
 * loc, since it is only ever called with a document's `attributes` value.
 */
function validateAttributes(value: unknown): PathedIssue[] {
  if (!isPlainObject(value)) {
    return [problem(["attributes"], "expected a mapping with string keys", "invalid_type")];
  }
  const problems: PathedIssue[] = [];
  for (const [key, item] of Object.entries(value)) {
    problems.push(...prefix("attributes", prefix(key, jsonProblems(item))));
  }
  return problems;
}

/**
 * Return every reason `value` is not a structurally-valid v3 array doc.
 *
 * Checks structure, not domain validity. Unknown top-level keys are allowed
 * (they are extension fields).
 */
function arrayMetadataV3Problems(value: unknown): PathedIssue[] {
  if (!isPlainObject(value)) {
    return [problem([], "expected a mapping", "invalid_type")];
  }
  const doc = value;
  const problems: PathedIssue[] = missingKeys(ARRAY_METADATA_REQUIRED_KEYS_V3, doc);
  problems.push(...validateExtensionFieldsV3(doc, ARRAY_METADATA_STANDARD_KEYS_V3));
  problems.push(...checkLiteral(doc, "zarr_format", 3));
  problems.push(...checkLiteral(doc, "node_type", "array"));
  problems.push(...validateDimSequence(doc, "shape"));
  if (has(doc, "fill_value")) {
    problems.push(...prefix("fill_value", jsonProblems(doc["fill_value"])));
  }
  for (const key of ["data_type", "chunk_grid", "chunk_key_encoding"]) {
    if (has(doc, key)) {
      problems.push(
        ...prefix(
          key,
          metadataFieldV3Problems(doc[key], { allowMustUnderstandFalse: false }),
        ),
      );
    }
  }
  for (const key of ["codecs", "storage_transformers"]) {
    if (has(doc, key)) {
      const entries = doc[key];
      if (!isDenseArray(entries)) {
        problems.push(problem([key], "expected a sequence", "invalid_type"));
      } else {
        if (key === "codecs" && entries.length === 0) {
          problems.push(problem(["codecs"], "expected at least one codec", "invalid_value"));
        }
        entries.forEach((entry, index) => {
          problems.push(...prefix(key, prefix(index, metadataFieldV3Problems(entry))));
        });
      }
    }
  }
  if (has(doc, "attributes")) {
    problems.push(...validateAttributes(doc["attributes"]));
  }
  if (has(doc, "dimension_names")) {
    // Simple typed sequences (dimension_names, shape, chunks) report a single
    // field-level loc, not per-bad-item locs; per-index locs are reserved for
    // the metadata-field lists (codecs, storage_transformers).
    const names = doc["dimension_names"];
    if (!isDenseArray(names)) {
      problems.push(problem(["dimension_names"], "expected a sequence", "invalid_type"));
    } else if (!names.every((item) => item === null || typeof item === "string")) {
      problems.push(
        problem(["dimension_names"], "expected items of str or None", "invalid_type"),
      );
    } else if (isIntSequence(doc["shape"]) && names.length !== doc["shape"].length) {
      problems.push(
        problem(["dimension_names"], "expected one name per dimension of shape", "invalid_value"),
      );
    }
  }
  return problems;
}


/**
 * Return every reason `value` is not a valid inline consolidated envelope.
 *
 * Locs are value-relative (the caller prefixes with `consolidated_metadata`
 * where appropriate). Entries recurse into the array and group document
 * validators.
 */
function consolidatedMetadataV3Problems(value: unknown): PathedIssue[] {
  return validateConsolidatedMetadataV3AtDepth(value, 0);
}

function validateConsolidatedMetadataV3AtDepth(
  value: unknown,
  depth: number,
): PathedIssue[] {
  // The group <-> consolidated document recursion consumes native stack per
  // level, so it carries the same depth budget as the JSON-value walk.
  if (depth >= MAX_JSON_DEPTH) {
    return [problem([], `maximum nesting depth of ${MAX_JSON_DEPTH} exceeded`, "invalid_value")];
  }
  if (!isPlainObject(value)) {
    return [problem([], "expected a mapping", "invalid_type")];
  }
  const env = value;
  const problems: PathedIssue[] = ["kind", "must_understand", "metadata"]
    .filter((key) => !(has(env, key)))
    .map((key) => problem([key], "missing required key", "missing_key"));
  problems.push(...unexpectedKeys(["kind", "must_understand", "metadata"], env));
  problems.push(...checkLiteral(env, "kind", "inline"));
  if (has(env, "must_understand") && env["must_understand"] !== false) {
    problems.push(problem(["must_understand"], "expected False", "invalid_value"));
  }
  if (has(env, "metadata")) {
    const entries = env["metadata"];
    if (!isPlainObject(entries)) {
      problems.push(problem(["metadata"], "expected a mapping", "invalid_type"));
    } else {
      for (const [key, entry] of Object.entries(entries)) {
        const nodeType = isPlainObject(entry) ? entry["node_type"] : undefined;
        if (nodeType === "array") {
          problems.push(...prefix("metadata", prefix(key, arrayMetadataV3Problems(entry))));
        } else if (nodeType === "group") {
          problems.push(
            ...prefix("metadata", prefix(key, validateGroupMetadataV3AtDepth(entry, depth + 1))),
          );
        } else {
          problems.push(
            problem(["metadata", key, "node_type"], "expected 'array' or 'group'", "invalid_value"),
          );
        }
      }
    }
  }
  return problems;
}

/**
 * Return every reason `value` is not a structurally-valid v3 group doc.
 *
 * Checks structure, not domain validity. Unknown top-level keys are allowed
 * (extension fields); a `consolidated_metadata` key, if present, is
 * deep-validated (envelope and entries).
 */
function groupMetadataV3Problems(value: unknown): PathedIssue[] {
  return validateGroupMetadataV3AtDepth(value, 0);
}

function validateGroupMetadataV3AtDepth(value: unknown, depth: number): PathedIssue[] {
  if (!isPlainObject(value)) {
    return [problem([], "expected a mapping", "invalid_type")];
  }
  const doc = value;
  const problems: PathedIssue[] = missingKeys(GROUP_METADATA_REQUIRED_KEYS_V3, doc);
  problems.push(
    ...validateExtensionFieldsV3(doc, GROUP_METADATA_STANDARD_KEYS_V3, [
      ZARR_V3_CONSOLIDATED_METADATA_KEY,
    ]),
  );
  problems.push(...checkLiteral(doc, "zarr_format", 3));
  problems.push(...checkLiteral(doc, "node_type", "group"));
  if (has(doc, "attributes")) {
    problems.push(...validateAttributes(doc["attributes"]));
  }
  if (
    has(doc, ZARR_V3_CONSOLIDATED_METADATA_KEY) &&
    doc[ZARR_V3_CONSOLIDATED_METADATA_KEY] !== null
  ) {
    // consolidated_metadata: null (a historical zarr-python bug) is
    // structurally accepted so those stores remain readable.
    problems.push(
      ...prefix(
        ZARR_V3_CONSOLIDATED_METADATA_KEY,
        validateConsolidatedMetadataV3AtDepth(doc[ZARR_V3_CONSOLIDATED_METADATA_KEY], depth + 1),
      ),
    );
  }
  return problems;
}


/**
 * Return every reason `value` is not a structurally-valid v3 metadata
 * document of either node type (the complete `zarr.json` grammar).
 *
 * Dispatches on `node_type`: `"array"` and `"group"` route to the
 * corresponding document validator; anything else is itself the problem.
 * This dispatcher has no direct Python analog (consumers there pick a
 * validator per node type); it exists for consumers handed an arbitrary
 * `zarr.json`, like editor tooling.
 */
function metadataV3Problems(value: unknown): PathedIssue[] {
  if (!isPlainObject(value)) {
    return [problem([], "expected a mapping", "invalid_type")];
  }
  const nodeType = value["node_type"];
  if (nodeType === "array") return arrayMetadataV3Problems(value);
  if (nodeType === "group") return groupMetadataV3Problems(value);
  if (!(has(value, "node_type"))) {
    return [problem(["node_type"], "missing required key", "missing_key")];
  }
  return [
    problem(["node_type"], `expected 'array' or 'group', got ${show(nodeType)}`, "invalid_value"),
  ];
}

/**
 * Return every reason `value` is not a structurally-valid v2 array doc.
 *
 * Checks structure, not domain validity: `dtype` must be a string or field
 * records, but the string content is not interpreted; `compressor` and
 * `filters` are required keys that may be `null`, and otherwise must be
 * codec configurations (objects with a string `id`).
 */
function arrayMetadataV2Problems(value: unknown): PathedIssue[] {
  if (!isPlainObject(value)) {
    return [problem([], "expected a mapping", "invalid_type")];
  }
  const doc = value;
  // Unlike .zgroup ("Other keys MUST NOT be present",
  // https://github.com/zarr-developers/zarr-specs/blob/fc7dd9c9beb5a50b87f9b08b00bf50fc0048482f/docs/v2/v2.0.rst#L313), the v2 array document is open: other keys "SHOULD NOT be
  // present ... and SHOULD be ignored" (https://github.com/zarr-developers/zarr-specs/blob/fc7dd9c9beb5a50b87f9b08b00bf50fc0048482f/docs/v2/v2.0.rst#L91-L92), so extras are not
  // structural problems (the v2 semantic layer reports them as advisories).
  const problems: PathedIssue[] = missingKeys(ARRAY_METADATA_REQUIRED_KEYS_V2, doc);
  problems.push(...checkLiteral(doc, "zarr_format", 2));
  const shapeProblems = validateDimSequence(doc, "shape");
  const chunksProblems = validateDimSequence(doc, "chunks");
  problems.push(...shapeProblems, ...chunksProblems);
  if (
    shapeProblems.length === 0 &&
    chunksProblems.length === 0 &&
    isIntSequence(doc["shape"]) &&
    isIntSequence(doc["chunks"]) &&
    doc["shape"].length !== doc["chunks"].length
  ) {
    problems.push(
      problem(["chunks"], "expected the same number of dimensions as shape", "invalid_value"),
    );
  }
  if (has(doc, "dtype") && !isDtypeV2(doc["dtype"])) {
    problems.push(
      problem(["dtype"], "expected a v2 dtype string or a sequence of field records", "invalid_type"),
    );
  }
  if (has(doc, "order") && !(ZARR_V2_ARRAY_ORDER as readonly unknown[]).includes(doc["order"])) {
    problems.push(
      problem(["order"], `expected 'C' or 'F', got ${show(doc["order"])}`, "invalid_value"),
    );
  }
  if (has(doc, "compressor") && doc["compressor"] !== null) {
    problems.push(...prefix("compressor", validateCodecV2(doc["compressor"])));
  }
  if (has(doc, "filters")) {
    const filters = doc["filters"];
    if (filters !== null && (!isDenseArray(filters) || !filters.every(isCodecV2))) {
      problems.push(
        problem(
          ["filters"],
          "expected null or a sequence of codec configurations with string 'id's",
          "invalid_type",
        ),
      );
    } else if (filters !== null && isDenseArray(filters)) {
      // "A list of JSON objects providing codec configurations, or null"
      // (https://github.com/zarr-developers/zarr-specs/blob/fc7dd9c9beb5a50b87f9b08b00bf50fc0048482f/docs/v2/v2.0.rst#L76-L79): an empty list is a list.
      filters.forEach((item, index) => {
        problems.push(...prefix("filters", prefix(index, jsonProblems(item))));
      });
    }
  }
  if (
    has(doc, "dimension_separator") &&
    !(ZARR_V2_ARRAY_DIMENSION_SEPARATOR as readonly unknown[]).includes(doc["dimension_separator"])
  ) {
    problems.push(
      problem(
        ["dimension_separator"],
        `expected '.' or '/', got ${show(doc["dimension_separator"])}`,
        "invalid_value",
      ),
    );
  }
  if (has(doc, "fill_value")) {
    problems.push(...prefix("fill_value", jsonProblems(doc["fill_value"])));
  }
  if (has(doc, "attributes")) {
    problems.push(...validateAttributes(doc["attributes"]));
  }
  return problems;
}


/**
 * Return every reason `value` is not a structurally-valid v2 group doc.
 *
 * Validates the in-memory merged form: the `.zgroup` fields plus an optional
 * `attributes` mapping folded in from `.zattrs`.
 */
function groupMetadataV2Problems(value: unknown): PathedIssue[] {
  if (!isPlainObject(value)) {
    return [problem([], "expected a mapping", "invalid_type")];
  }
  const doc = value;
  const problems: PathedIssue[] = missingKeys(GROUP_METADATA_REQUIRED_KEYS_V2, doc);
  problems.push(...unexpectedKeys(GROUP_METADATA_STANDARD_KEYS_V2, doc));
  problems.push(...checkLiteral(doc, "zarr_format", 2));
  if (has(doc, "attributes")) {
    problems.push(...validateAttributes(doc["attributes"]));
  }
  return problems;
}


/**
 * Return every reason `value` is not a structurally-valid `.zmetadata` doc
 * (v2 consolidated metadata).
 *
 * Ported from `ZarrV2ConsolidatedMetadata.from_json` in the Python reference
 * implementation. Entries are validated as JSON trees, not as per-node
 * documents: which nodes had a `.zattrs` file at all is information the
 * canonical representation must keep, and interpreting entries into node
 * documents is consumer work.
 */
function consolidatedMetadataV2Problems(value: unknown): PathedIssue[] {
  if (!isPlainObject(value)) {
    return [problem([], "expected a mapping", "invalid_type")];
  }
  const doc = value;
  const problems: PathedIssue[] = ["zarr_consolidated_format", "metadata"]
    .filter((key) => !(has(doc, key)))
    .map((key) => problem([key], "missing required key", "missing_key"));
  problems.push(...unexpectedKeys(["zarr_consolidated_format", "metadata"], doc));
  problems.push(...checkLiteral(doc, "zarr_consolidated_format", 1));
  if (has(doc, "metadata")) {
    const entries = doc["metadata"];
    if (!isPlainObject(entries)) {
      problems.push(problem(["metadata"], "expected a mapping with string keys", "invalid_type"));
    } else {
      for (const [key, item] of Object.entries(entries)) {
        problems.push(...prefix("metadata", prefix(key, jsonProblems(item))));
      }
    }
  }
  return problems;
}


// TextDecoder/TextEncoder are globals in every supported runtime (Node,
// browsers, workers) but live in the "dom" lib types; declare the minimal
// surface here rather than tie this platform-neutral package to either
// lib.dom or @types/node.
declare const TextDecoder: new (
  label?: string,
  options?: { fatal?: boolean },
) => { decode(input: Uint8Array): string };
declare const TextEncoder: new () => { encode(input: string): Uint8Array };

/**
 * A key-value store fragment holding metadata documents as bytes or text:
 * either a `Map` or a plain object keyed by store key.
 */
export type StoreMapping =
  | ReadonlyMap<string, Uint8Array | string>
  | Record<string, Uint8Array | string | undefined>;

function storeGet(mapping: StoreMapping, key: string): Uint8Array | string | undefined {
  if (mapping instanceof Map) {
    return (mapping as ReadonlyMap<string, Uint8Array | string>).get(key);
  }
  const record = mapping as Record<string, Uint8Array | string | undefined>;
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/**
 * Decode the JSON document stored at `key` in `mapping`.
 *
 * Ported from the Python reference's `load_store_json`. Every ingestion
 * failure surfaces as `MetadataValidationError`: a missing store key is a
 * `missing_key` problem and undecodable bytes or malformed JSON are an
 * `invalid_json` problem, rather than leaking a decode exception to
 * callers. `JSON.parse` already rejects the non-standard `NaN`/`Infinity`
 * constants Python has to opt out of explicitly.
 *
 * One intentional divergence: bytes must be UTF-8 (RFC 8259's mandated
 * interchange encoding). Python's `json.loads` auto-detects UTF-16/32 and
 * would accept such documents; here they are reported as `invalid_json`.
 */
/**
 * Decode JSON text (or UTF-8 bytes) into a metadata value, keeping integers
 * exact.
 *
 * Like `JSON.parse`, except an integer literal beyond
 * `Number.MAX_SAFE_INTEGER` decodes to a `bigint` instead of a rounded
 * `number`, so range checks such as an int64 fill value's ("within the
 * representable range of the data type", https://github.com/zarr-developers/zarr-specs/blob/fc7dd9c9beb5a50b87f9b08b00bf50fc0048482f/docs/v3/data-types/index.rst#L60-L61) see the value the
 * document actually spells. Relies on `JSON.parse` source-text access
 * (Node >= 21 and current browsers); where that is unavailable, such
 * literals round exactly as with `JSON.parse`. Throws `SyntaxError` on
 * malformed JSON and `TypeError` on invalid UTF-8.
 */
export function decodeStoreJson(raw: string | Uint8Array): unknown {
  const text =
    typeof raw === "string" ? raw : new TextDecoder("utf-8", { fatal: true }).decode(raw);
  return JSON.parse(text, (_key, value: unknown, context?: { source?: string }) =>
    typeof value === "number" &&
    !Number.isSafeInteger(value) &&
    context?.source !== undefined &&
    /^-?\d+$/.test(context.source)
      ? BigInt(context.source)
      : value,
  );
}

export function loadStoreJson(mapping: StoreMapping, key: string): unknown {
  const raw = storeGet(mapping, key);
  if (raw === undefined) {
    throw new MetadataValidationError(treeOf([problem([key], "missing store key", "missing_key")]));
  }
  try {
    return decodeStoreJson(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new MetadataValidationError(
      treeOf([problem([key], `invalid JSON: ${message}`, "invalid_json")]),
    );
  }
}

/**
 * Encode a metadata document as strict RFC 8259 JSON bytes.
 *
 * Ported from the Python reference's `dump_store_json` (`allow_nan=False`):
 * a non-JSON value — a non-finite number, a `Map` — throws
 * `MetadataValidationError` instead of being silently rewritten to `null`
 * the way bare `JSON.stringify` would. A `bigint` is written as its exact
 * integer literal (bare `JSON.stringify` throws on one).
 */
export function dumpStoreJson(
  value: unknown,
  options: { indent?: number | string } = {},
): Uint8Array {
  const problems = jsonProblems(value);
  if (problems.length > 0) throw new MetadataValidationError(treeOf(problems));
  // JSON.stringify cannot emit a bigint: stand each one in as a string
  // carrying a per-call nonce, then splice the digits over its quoted form.
  const nonce = `zarr-metadata-bigint-${crypto.randomUUID()}:`;
  const text = JSON.stringify(
    value,
    (_key, item: unknown) => (typeof item === "bigint" ? `${nonce}${item}` : item),
    options.indent,
  ).replace(new RegExp(`"${nonce}(-?\\d+)"`, "g"), "$1");
  return new TextEncoder().encode(text);
}

// ---------------------------------------------------------------------------
// Public API. Each document kind gets four entry points built on one
// internal problems function:
//
//   validate*(value)  -> ErrorTree            (empty tree = valid)
//   is*(value)        -> type guard
//   parse*(value)     -> narrowed document, or throws MetadataValidationError
//   safeParse*(value) -> ParseResult<T> discriminated union
// ---------------------------------------------------------------------------

function toResult<T>(value: unknown, problems: PathedIssue[]): ParseResult<T> {
  return problems.length === 0
    ? { success: true, value: value as T }
    : { success: false, errors: treeOf(problems) };
}

function toParsed<T>(value: unknown, problems: PathedIssue[]): T {
  if (problems.length > 0) throw new MetadataValidationError(treeOf(problems));
  return value as T;
}

/** Every reason `value` is not JSON-serializable, as an error tree. */
export function validateJson(value: unknown): ErrorTree {
  return treeOf(jsonProblems(value));
}
/** Whether `value` is a JSON structure (recursively). */
export function isJson(value: unknown): value is JSONValue {
  return jsonProblems(value).length === 0;
}
/** Return `value` narrowed to `JSONValue`, or throw `MetadataValidationError`. */
export function parseJson(value: unknown): JSONValue {
  return toParsed(value, jsonProblems(value));
}
export function safeParseJson(value: unknown): ParseResult<JSONValue> {
  return toResult(value, jsonProblems(value));
}

/** Every reason `value` is not a v3 metadata field, as an error tree. */
export function validateMetadataFieldV3(
  value: unknown,
  options: { allowMustUnderstandFalse?: boolean } = {},
): ErrorTree {
  return treeOf(metadataFieldV3Problems(value, options));
}
/** Whether `value` is a v3 metadata field: a bare name or a named config. */
export function isMetadataFieldV3(value: unknown): value is ZarrV3MetadataFieldJSON {
  return metadataFieldV3Problems(value).length === 0;
}
export function parseMetadataFieldV3(value: unknown): ZarrV3MetadataFieldJSON {
  return toParsed(value, metadataFieldV3Problems(value));
}
export function safeParseMetadataFieldV3(value: unknown): ParseResult<ZarrV3MetadataFieldJSON> {
  return toResult(value, metadataFieldV3Problems(value));
}

/** Every reason `value` is not a v3 array document, as an error tree. */
export function validateArrayMetadataV3(value: unknown): ErrorTree {
  return treeOf(arrayMetadataV3Problems(value));
}
export function isArrayMetadataV3(value: unknown): value is ZarrV3ArrayMetadataJSON {
  return arrayMetadataV3Problems(value).length === 0;
}
export function parseArrayMetadataV3(value: unknown): ZarrV3ArrayMetadataJSON {
  return toParsed(value, arrayMetadataV3Problems(value));
}
export function safeParseArrayMetadataV3(value: unknown): ParseResult<ZarrV3ArrayMetadataJSON> {
  return toResult(value, arrayMetadataV3Problems(value));
}

/** Every reason `value` is not a v3 group document, as an error tree. */
export function validateGroupMetadataV3(value: unknown): ErrorTree {
  return treeOf(groupMetadataV3Problems(value));
}
export function isGroupMetadataV3(value: unknown): value is ZarrV3GroupMetadataJSON {
  return groupMetadataV3Problems(value).length === 0;
}
export function parseGroupMetadataV3(value: unknown): ZarrV3GroupMetadataJSON {
  return toParsed(value, groupMetadataV3Problems(value));
}
export function safeParseGroupMetadataV3(value: unknown): ParseResult<ZarrV3GroupMetadataJSON> {
  return toResult(value, groupMetadataV3Problems(value));
}

/** Every reason `value` is not an inline consolidated envelope, as an error tree. */
export function validateConsolidatedMetadataV3(value: unknown): ErrorTree {
  return treeOf(consolidatedMetadataV3Problems(value));
}
export function isConsolidatedMetadataV3(
  value: unknown,
): value is ZarrV3ConsolidatedMetadataJSON {
  return consolidatedMetadataV3Problems(value).length === 0;
}
export function parseConsolidatedMetadataV3(value: unknown): ZarrV3ConsolidatedMetadataJSON {
  return toParsed(value, consolidatedMetadataV3Problems(value));
}
export function safeParseConsolidatedMetadataV3(
  value: unknown,
): ParseResult<ZarrV3ConsolidatedMetadataJSON> {
  return toResult(value, consolidatedMetadataV3Problems(value));
}

/**
 * Every reason `value` is not a v3 metadata document of either node type
 * (the complete `zarr.json` grammar, dispatching on `node_type`), as an
 * error tree.
 */
export function validateMetadataV3(value: unknown): ErrorTree {
  return treeOf(metadataV3Problems(value));
}
export function isMetadataV3(value: unknown): value is ZarrV3MetadataJSON {
  return metadataV3Problems(value).length === 0;
}
export function parseMetadataV3(value: unknown): ZarrV3MetadataJSON {
  return toParsed(value, metadataV3Problems(value));
}
export function safeParseMetadataV3(value: unknown): ParseResult<ZarrV3MetadataJSON> {
  return toResult(value, metadataV3Problems(value));
}

/** Every reason `value` is not a merged v2 array document, as an error tree. */
export function validateArrayMetadataV2(value: unknown): ErrorTree {
  return treeOf(arrayMetadataV2Problems(value));
}
export function isArrayMetadataV2(value: unknown): value is ZarrV2ArrayMetadataJSON {
  return arrayMetadataV2Problems(value).length === 0;
}
export function parseArrayMetadataV2(value: unknown): ZarrV2ArrayMetadataJSON {
  return toParsed(value, arrayMetadataV2Problems(value));
}
export function safeParseArrayMetadataV2(value: unknown): ParseResult<ZarrV2ArrayMetadataJSON> {
  return toResult(value, arrayMetadataV2Problems(value));
}

/** Every reason `value` is not a merged v2 group document, as an error tree. */
export function validateGroupMetadataV2(value: unknown): ErrorTree {
  return treeOf(groupMetadataV2Problems(value));
}
export function isGroupMetadataV2(value: unknown): value is ZarrV2GroupMetadataJSON {
  return groupMetadataV2Problems(value).length === 0;
}
export function parseGroupMetadataV2(value: unknown): ZarrV2GroupMetadataJSON {
  return toParsed(value, groupMetadataV2Problems(value));
}
export function safeParseGroupMetadataV2(value: unknown): ParseResult<ZarrV2GroupMetadataJSON> {
  return toResult(value, groupMetadataV2Problems(value));
}

/** Every reason `value` is not a `.zmetadata` document, as an error tree. */
export function validateConsolidatedMetadataV2(value: unknown): ErrorTree {
  return treeOf(consolidatedMetadataV2Problems(value));
}
export function isConsolidatedMetadataV2(
  value: unknown,
): value is ZarrV2ConsolidatedMetadataJSON {
  return consolidatedMetadataV2Problems(value).length === 0;
}
export function parseConsolidatedMetadataV2(value: unknown): ZarrV2ConsolidatedMetadataJSON {
  return toParsed(value, consolidatedMetadataV2Problems(value));
}
export function safeParseConsolidatedMetadataV2(
  value: unknown,
): ParseResult<ZarrV2ConsolidatedMetadataJSON> {
  return toResult(value, consolidatedMetadataV2Problems(value));
}

/**
 * The extension-field keys of a v3 metadata document that a reader is
 * obligated to understand.
 *
 * Per the v3 spec an extension field is implicitly `must_understand: true`
 * unless it is an object carrying the explicit member
 * `"must_understand": false`, and an implementation MUST refuse to open a
 * node with obligated fields it does not recognize. This reports the
 * obligation only — which fields a reader actually recognizes is the
 * reader's business, so these keys are advisory, not validation problems
 * (the document is structurally valid). Returns `[]` for anything that is
 * not shaped like a v3 array or group document. The
 * reference-implementation `consolidated_metadata` convention on groups is
 * treated as recognized.
 */
export function mustUnderstandExtensionFieldsV3(value: unknown): string[] {
  if (!isPlainObject(value)) return [];
  const nodeType = value["node_type"];
  let reserved: ReadonlyArray<string>;
  if (nodeType === "array") {
    reserved = ARRAY_METADATA_STANDARD_KEYS_V3;
  } else if (nodeType === "group") {
    reserved = [...GROUP_METADATA_STANDARD_KEYS_V3, ZARR_V3_CONSOLIDATED_METADATA_KEY];
  } else {
    return [];
  }
  return Object.keys(value).filter((key) => {
    if (reserved.includes(key)) return false;
    const field = value[key];
    return !(isPlainObject(field) && field["must_understand"] === false);
  });
}

/**
 * Per-entry document validation for `.zmetadata` (v2 consolidated) — the
 * consumer-side interpretation the reference implementation's model
 * deliberately leaves out (its `metadata` map is kept verbatim). Each entry
 * is validated by what its key names: `<path>/.zarray` as an on-disk v2
 * array document, `<path>/.zgroup` as an on-disk v2 group document (both
 * additionally rejecting an `attributes` member, which on disk lives only
 * in the sibling `.zattrs` file), and `<path>/.zattrs` as a JSON object.
 * Keys naming none of the three are left alone.
 *
 * This is a TS-only layer over `validateConsolidatedMetadataV2` (which
 * stays envelope-only for conformance-corpus parity with Python); run both.
 */
export function validateConsolidatedDocumentsV2(value: unknown): ErrorTree {
  if (!isPlainObject(value)) return treeOf([]);
  const entries = value["metadata"];
  if (!isPlainObject(entries)) return treeOf([]);
  const problems: PathedIssue[] = [];
  const onDisk = (base: PathedIssue[], entry: unknown): PathedIssue[] => {
    if (isPlainObject(entry) && has(entry, "attributes")) {
      return [
        ...base.filter((issue) => issue.path[0] !== "attributes"),
        problem(
          ["attributes"],
          "unexpected document member (on disk, attributes live in the sibling .zattrs file)",
          "invalid_value",
        ),
      ];
    }
    return base;
  };
  for (const [key, entry] of Object.entries(entries)) {
    const basename = key.slice(key.lastIndexOf("/") + 1);
    let entryProblems: PathedIssue[] | undefined;
    if (basename === ".zarray") {
      entryProblems = onDisk(arrayMetadataV2Problems(entry), entry);
    } else if (basename === ".zgroup") {
      entryProblems = onDisk(groupMetadataV2Problems(entry), entry);
    } else if (basename === ".zattrs") {
      entryProblems = isPlainObject(entry)
        ? jsonProblems(entry)
        : [problem([], "expected a mapping with string keys", "invalid_type")];
    }
    if (entryProblems !== undefined && entryProblems.length > 0) {
      problems.push(...prefix("metadata", prefix(key, entryProblems)));
    }
  }
  return treeOf(problems);
}
