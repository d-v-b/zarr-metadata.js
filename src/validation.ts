/**
 * Structural validation for Zarr metadata documents.
 *
 * A port of the structural part of the `zarr_metadata.model` readers (the
 * Python reference implementation): what they check whatever extensions
 * their scope defines. Validators check JSON structure (key presence, value
 * shapes, fixed literals like `zarr_format`, the metadata field envelope and
 * its extension names, v2 typestrs and field records, and the hierarchy a
 * consolidated listing forms), not what an extension's name means; that is
 * the semantic layer (`semantics.ts`). Together the two report what the
 * reference readers report in their default scope, which the conformance
 * corpus asserts. Each concept gets a `validate*` function returning every
 * problem found, an `is*` type guard, and a `parse*` function that narrows
 * or throws `MetadataValidationError`.
 *
 * A value of the wrong JSON type is an `invalid_type`; a value of the right
 * type outside a closed set (`node_type: "Array"`) is an `invalid_value`;
 * a key a closed object does not declare is an `unknown_key`.
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
  ARRAY_METADATA_STANDARD_KEYS_V2,
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

/** One `unknown_key` problem per member outside a closed object's declared keys. */
function unexpectedKeys(
  allowed: ReadonlyArray<string>,
  doc: Record<string, unknown>,
): PathedIssue[] {
  return Object.keys(doc)
    .filter((key) => !allowed.includes(key))
    .map((key) => problem([key], `unexpected key ${show(key)}`, "unknown_key"));
}

/** The JSON type of `value`, as the reference implementation compares types. */
function jsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/**
 * The problem for `value` outside the closed set `allowed`: `invalid_type`
 * when no member of the set has its JSON type (a number where every member
 * is a string), else `invalid_value`.
 */
function outsideOf(
  path: IssuePath,
  value: unknown,
  allowed: ReadonlyArray<string | number | boolean>,
): PathedIssue {
  const sameType = allowed.some((entry) => jsonType(entry) === jsonType(value));
  const expected = allowed.length === 1
    ? show(allowed[0])
    : `one of ${show([...allowed].sort())}`;
  return problem(
    path,
    `expected ${expected}, got ${show(value)}`,
    sameType ? "invalid_value" : "invalid_type",
  );
}

/** One problem if `doc[key]` is present but not `expected`. */
function checkLiteral(
  doc: Record<string, unknown>,
  key: string,
  expected: string | number | boolean,
): PathedIssue[] {
  if (has(doc, key) && doc[key] !== expected) {
    return [outsideOf([key], doc[key], [expected])];
  }
  return [];
}

/**
 * A registered extension name: the spec's `^[a-z][a-z0-9-_.]+$`. A URI,
 * which earlier versions of the spec required, is still permitted; the URI
 * pattern matches a scheme, a colon, and URI characters (RFC 3986).
 */
const EXTENSION_NAME = /^[a-z][a-z0-9_.-]+$/;
const URI_NAME = /^[A-Za-z][A-Za-z0-9+.-]*:[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+$/;

/** Whether `name` is a valid v3 extension name: a registered name or a URI. */
function isExtensionNameV3(name: string): boolean {
  return EXTENSION_NAME.test(name) || URI_NAME.test(name);
}

function nameProblems(name: string, path: IssuePath): PathedIssue[] {
  if (isExtensionNameV3(name)) return [];
  return [
    problem(
      path,
      "expected an extension name -- lower-case letters, digits, '-', '_' and '.', " +
        `starting with a letter -- or a URI, got ${show(name)}`,
      "invalid_value",
    ),
  ];
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
 * optional `configuration` and `must_understand` members. Every name must be
 * a valid extension name (`isExtensionNameV3`).
 */
function metadataFieldV3Problems(
  value: unknown,
  options: { allowMustUnderstandFalse?: boolean } = {},
): PathedIssue[] {
  const { allowMustUnderstandFalse = true } = options;
  if (typeof value === "string") return nameProblems(value, []);
  if (!isPlainObject(value)) {
    return [
      problem([], "expected a metadata field (string or extension object)", "invalid_type"),
    ];
  }
  const problems: PathedIssue[] = [];
  const allowedKeys = new Set(["name", "configuration", "must_understand"]);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      problems.push(problem([key], `unexpected key ${show(key)}`, "unknown_key"));
    }
  }
  if (!has(value, "name")) {
    problems.push(problem(["name"], "missing required key", "missing_key"));
  } else if (typeof value["name"] !== "string") {
    problems.push(problem(["name"], "expected a string name", "invalid_type"));
  } else {
    problems.push(...nameProblems(value["name"], ["name"]));
  }
  if (has(value, "configuration")) {
    const configuration = value["configuration"];
    if (!isPlainObject(configuration)) {
      problems.push(problem(["configuration"], "expected an object", "invalid_type"));
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
 * Whether `value` is an array of integers.
 *
 * `Number.isInteger` rejects booleans, non-finite numbers, and non-integral
 * floats, mirroring the Python bool-is-not-int rule.
 */
function isIntSequence(value: unknown): value is number[] {
  return isDenseArray(value) && value.every((item) => Number.isInteger(item));
}

/**
 * Validate a dimension sequence (`shape` / `chunks`) if present in `doc`.
 * Dimension lengths are non-negative integers.
 */
function validateDimSequence(doc: Record<string, unknown>, key: string): PathedIssue[] {
  if (!(has(doc, key))) return [];
  const value = doc[key];
  if (!isIntSequence(value)) {
    return [problem([key], "expected an array of integers", "invalid_type")];
  }
  if (value.some((item) => item < 0)) {
    return [problem([key], "expected non-negative integers", "invalid_value")];
  }
  return [];
}

/**
 * A NumPy typestr: a byte order, a type code, a size in bytes (only `|O`
 * omits it), and an optional bracketed time unit with its multiplier.
 * ASCII digits only, as NumPy reads them.
 */
const TYPESTR = /^([<>|])([A-Za-z])([0-9]*)(?:\[([0-9]*)([A-Za-zμ]+)\])?$/;

/** Every reason the string `name` is not a NumPy typestr. Which typestrs name real types is not checked. */
function typestrProblems(name: string): PathedIssue[] {
  const match = TYPESTR.exec(name);
  if (match === null) {
    return [
      problem(
        [],
        "expected a NumPy typestr -- a byte order '<', '>' or '|', a type code and a size " +
          `in bytes, '<f4' -- got ${show(name)}`,
        "invalid_value",
      ),
    ];
  }
  if (match[3] === "" && match[2] !== "O") {
    return [
      problem([], `expected a size in bytes after the type code, '<f4', got ${show(name)}`, "invalid_value"),
    ];
  }
  return [];
}

/**
 * Return every reason `value` is not shaped like a v2 dtype: a typestr, or
 * a list of field records.
 *
 * A field record is a `[name, dtype]` or `[name, dtype, shape]` array, where
 * `dtype` is itself a dtype and `shape` an array of non-negative integers,
 * and no two records share a name. A record's problems are located as the
 * reference implementation's union check locates them: a record whose
 * length fits neither form, or that fits one form with problems in both
 * readings, is reported as a whole.
 */
function dtypeV2Problems(value: unknown, depth = 0): PathedIssue[] {
  if (typeof value === "string") return typestrProblems(value);
  if (!isDenseArray(value)) {
    return [
      problem(
        [],
        `expected a v2 dtype -- a NumPy typestr, or an array of field records -- got ${show(value)}`,
        "invalid_type",
      ),
    ];
  }
  // A dtype nested past the depth cap is rejected rather than recursed
  // into; this is the same hardening rule as validateJson's.
  if (depth >= MAX_JSON_DEPTH) {
    return [problem([], `maximum nesting depth of ${MAX_JSON_DEPTH} exceeded`, "invalid_value")];
  }
  const problems: PathedIssue[] = [];
  // The records' own shapes decide whether the names are compared, as the
  // reference implementation's struct rules run only on records that check.
  let sound = true;
  value.forEach((record, index) => {
    const read = fieldRecordV2Problems(record, depth);
    if (read.own.length > 0 || !read.named) sound = false;
    problems.push(...prefix(index, [...read.own, ...read.nested]));
  });
  if (sound) {
    const seen = new Map<string, number>();
    value.forEach((record, index) => {
      const name = (record as unknown[])[0] as string;
      const first = seen.get(name);
      if (first === undefined) {
        seen.set(name, index);
      } else {
        problems.push(
          problem(
            [index, 0],
            `duplicate field name ${show(name)}, already used by record ${first}`,
            "invalid_value",
          ),
        );
      }
    });
  }
  return problems;
}

/**
 * The problems of one v2 field record: `own` from its shape, and `nested`
 * from the dtype it holds (read only when the record reads as a form that
 * reaches its dtype). `named` says whether that dtype is a string or a list.
 */
function fieldRecordV2Problems(
  record: unknown,
  depth: number,
): { own: PathedIssue[]; nested: PathedIssue[]; named: boolean } {
  const wholeRecord = (form: string): PathedIssue[] => [
    problem([], `expected ${form}, got ${show(record)}`, "invalid_type"),
  ];
  if (!isDenseArray(record)) {
    return {
      own: wholeRecord("an array of 3 elements or a [name, dtype] pair"),
      nested: [],
      named: false,
    };
  }
  const nameProblem: PathedIssue[] =
    typeof record[0] === "string" ? [] : [problem([0], "expected a string", "invalid_type")];
  let own: PathedIssue[];
  if (record.length === 3) {
    const shape = record[2];
    const shapeProblems: PathedIssue[] = [];
    if (!isDenseArray(shape)) {
      shapeProblems.push(problem([2], `expected an array, got ${show(shape)}`, "invalid_type"));
    } else {
      shape.forEach((length, axis) => {
        if (!Number.isInteger(length)) {
          shapeProblems.push(problem([2, axis], `expected an integer, got ${show(length)}`, "invalid_type"));
        } else if ((length as number) < 0) {
          shapeProblems.push(problem([2, axis], `expected an integer >= 0, got ${show(length)}`, "invalid_value"));
        }
      });
    }
    own = [...nameProblem, ...shapeProblems];
    // The [name, dtype] form fails this record once, on its length; it wins
    // only when the three-element reading has more problems than that.
    if (own.length > 1) {
      return { own: wholeRecord("a [name, dtype] pair"), nested: [], named: false };
    }
  } else if (record.length === 2 && nameProblem.length === 0) {
    own = [];
  } else {
    // A two-element record with a bad name ties with the three-element
    // reading, which comes first and fails on the length.
    return { own: wholeRecord("an array of 3 elements"), nested: [], named: false };
  }
  const dtype = record[1];
  return {
    own,
    nested: prefix(1, dtypeV2Problems(dtype, depth + 1)),
    named: typeof dtype === "string" || Array.isArray(dtype),
  };
}

/**
 * Return every reason `value` is not shaped like a v2 codec configuration:
 * an object with a string `id`, holding JSON.
 */
function codecV2Problems(value: unknown): PathedIssue[] {
  if (!isPlainObject(value)) {
    return [problem([], "expected a codec configuration with a string 'id'", "invalid_type")];
  }
  if (!has(value, "id")) return [problem(["id"], "missing required key", "missing_key")];
  if (typeof value["id"] !== "string") {
    return [problem(["id"], `expected a string codec id, got ${show(value["id"])}`, "invalid_type")];
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
    return [problem(["attributes"], "expected an object with string keys", "invalid_type")];
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
    return [problem([], "expected an object", "invalid_type")];
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
  // Every extension point must be understood, so `must_understand: false`
  // is refused at each one, codecs and storage transformers included:
  // ignoring a codec gives wrong bytes just as ignoring a data type gives
  // wrong values. It keeps its meaning on unknown top-level extension
  // fields, which a reader really can skip.
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
        problems.push(problem([key], "expected an array", "invalid_type"));
      } else {
        if (key === "codecs" && entries.length === 0) {
          problems.push(
            problem(["codecs"], "expected an array -> bytes codec, got none", "invalid_value"),
          );
        }
        entries.forEach((entry, index) => {
          problems.push(
            ...prefix(
              key,
              prefix(index, metadataFieldV3Problems(entry, { allowMustUnderstandFalse: false })),
            ),
          );
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
      problems.push(problem(["dimension_names"], "expected an array", "invalid_type"));
    } else if (!names.every((item) => item === null || typeof item === "string")) {
      problems.push(
        problem(["dimension_names"], "expected an array of strings or null", "invalid_type"),
      );
    } else if (
      // A shape with its own problem gives no number of dimensions to compare.
      isIntSequence(doc["shape"]) &&
      validateDimSequence(doc, "shape").length === 0 &&
      names.length !== doc["shape"].length
    ) {
      problems.push(
        problem(["dimension_names"], "expected one name per dimension of shape", "invalid_value"),
      );
    }
  }
  return problems;
}


const CONSOLIDATED_ENVELOPE_KEYS = ["kind", "must_understand", "metadata"] as const;

/**
 * Every reason `value` is not the envelope the core spec fixes for a group's
 * `consolidated_metadata` member: `kind` is `"inline"`, `must_understand` is
 * `false`, `metadata` is an object, and nothing else. Locs are
 * value-relative. With `checkEntries`, each entry is checked as JSON only,
 * as a group document holds it.
 */
function consolidatedEnvelopeProblems(value: unknown, checkEntries: boolean): PathedIssue[] {
  if (!isPlainObject(value)) {
    return [problem([], "expected an object", "invalid_type")];
  }
  const env = value;
  const problems: PathedIssue[] = CONSOLIDATED_ENVELOPE_KEYS
    .filter((key) => !(has(env, key)))
    .map((key) => problem([key], "missing required key", "missing_key"));
  problems.push(...unexpectedKeys(CONSOLIDATED_ENVELOPE_KEYS, env));
  problems.push(...checkLiteral(env, "kind", "inline"));
  problems.push(...checkLiteral(env, "must_understand", false));
  if (has(env, "metadata")) {
    const entries = env["metadata"];
    if (!isPlainObject(entries)) {
      problems.push(problem(["metadata"], "expected an object", "invalid_type"));
    } else if (checkEntries) {
      for (const [key, entry] of Object.entries(entries)) {
        problems.push(...prefix("metadata", prefix(key, jsonProblems(entry))));
      }
    }
  }
  return problems;
}

type NodeTypeV3 = "array" | "group";

/**
 * The node type `value` declares, or, when it declares neither `"array"` nor
 * `"group"` (or is not an object), the problems saying so. A document with
 * no usable node type has its `zarr_format` checked too, so a document in
 * another format is reported as not v3.
 */
function nodeTypeV3(value: unknown): { nodeType: NodeTypeV3 | undefined; problems: PathedIssue[] } {
  if (!isPlainObject(value)) {
    return { nodeType: undefined, problems: [problem([], "expected an object", "invalid_type")] };
  }
  const nodeType = value["node_type"];
  if (nodeType === "array" || nodeType === "group") return { nodeType, problems: [] };
  const problems = [...missingKeys(["zarr_format"], value), ...checkLiteral(value, "zarr_format", 3)];
  problems.push(
    has(value, "node_type")
      ? outsideOf(["node_type"], nodeType, ["array", "group"])
      : problem(["node_type"], "missing required key", "missing_key"),
  );
  return { nodeType: undefined, problems };
}

/** Each reason `name` is not a node name. Empty for a valid name, including the root's `""`. */
function nameFaults(name: string): string[] {
  const faults: string[] = [];
  if (name.includes("/")) faults.push('holds "/"');
  if (name !== "" && /^\.+$/.test(name)) faults.push("is periods alone");
  if (name.startsWith("__")) faults.push('starts with the reserved "__"');
  if (name === "zarr.json") faults.push('is the reserved "zarr.json"');
  return faults;
}

/** Each reason `path` is not a node path. Empty for a valid path, including the root's `/`. */
function pathFaults(path: string): string[] {
  if (path === "/") return [];
  if (!path.startsWith("/")) return ['does not start with "/"'];
  const faults: string[] = [];
  const names = path.slice(1).split("/");
  if (path.endsWith("/")) {
    faults.push('ends with "/"');
    names.pop();
  }
  const faulty = names.filter((name) => name === "" || nameFaults(name).length > 0);
  if (faulty.length > 0) {
    const first = faulty[0] as string;
    faults.push(
      first === ""
        ? 'holds an empty name between two "/"'
        : `holds ${show(first)}, a name that ${nameFaults(first).join(" and ")}`,
    );
    if (faulty.length > 1) faults.push(`holds ${faulty.length - 1} more invalid names`);
  }
  return faults;
}

/** Each reason `key` is not the path of a node below a group, relative to that group. */
function belowFaults(key: string): string[] {
  if (key === "") return ["is the group's own"];
  if (key.startsWith("/")) return ['starts with "/"'];
  return pathFaults(`/${key}`);
}

/**
 * Why `nodes` (the node type of each node by path; `null` for unknown, which
 * counts as a group) is not a tree: a node below an array is an
 * `invalid_value` at the node, and the nearest missing group above a node
 * is reported once, as a `missing_key` at that group's path. Locs are the
 * node paths themselves; the caller maps them into the document.
 */
function treeProblems(nodes: ReadonlyMap<string, NodeTypeV3 | null>): Array<{ path: string; message: string; kind: IssueKind }> {
  const found: Array<{ path: string; message: string; kind: IssueKind }> = [];
  const reported = new Set<string>();
  for (const path of nodes.keys()) {
    if (path === "/") continue;
    const names = path.slice(1).split("/");
    let holder: NodeTypeV3 | undefined;
    let holderPath = "/";
    let heldDepth = -1;
    for (let depth = 0; depth < names.length; depth++) {
      const ancestor = depth === 0 ? "/" : `/${names.slice(0, depth).join("/")}`;
      if (nodes.has(ancestor)) {
        holder = nodes.get(ancestor) ?? "group";
        holderPath = ancestor;
        heldDepth = depth;
      }
    }
    const missing = names.length - 1 - heldDepth;
    if (holder === "array") {
      found.push({
        path,
        message: `expected a node below a group, got ${show(path)}, below the array ${show(holderPath)}`,
        kind: "invalid_value",
      });
    } else if (missing !== 0) {
      const nearest = path.slice(0, path.lastIndexOf("/")) || "/";
      if (!reported.has(nearest)) {
        reported.add(nearest);
        const above = missing - 1;
        found.push({
          path: nearest,
          message:
            `missing the group holding ${show(path)}` +
            (above === 0 ? "" : `, and ${above} group${above === 1 ? "" : "s"} above it`),
          kind: "missing_key",
        });
      }
    }
  }
  return found;
}

/**
 * Every structural reason the documents an inline `consolidated_metadata`
 * member lists are not valid, without the envelope's own problems. Each
 * entry is keyed by a node path below the group and is a complete array or
 * group document; together with the group they form a hierarchy rooted at
 * it. A listed group that lists documents of its own (and has no problem
 * of its own) has its listing read the same way, and every node it lists
 * must also be listed by the outer group, with the same node type.
 */
function consolidatedEntriesV3Problems(value: unknown, depth: number): PathedIssue[] {
  // The group <-> consolidated document recursion consumes native stack per
  // level, so it carries the same depth budget as the JSON-value walk.
  if (depth >= MAX_JSON_DEPTH) {
    return [problem([], `maximum nesting depth of ${MAX_JSON_DEPTH} exceeded`, "invalid_value")];
  }
  if (!isPlainObject(value) || !isPlainObject(value["metadata"])) return [];
  const entries = value["metadata"];
  const problems: PathedIssue[] = [];
  const nodeTypes = new Map<string, NodeTypeV3 | null>();
  const listings = new Map<string, Record<string, unknown>>();
  for (const [key, entry] of Object.entries(entries)) {
    const faults = belowFaults(key);
    if (faults.length > 0) {
      problems.push(
        problem(
          ["metadata", key],
          `expected the path of a node below the group, got ${show(key)}, which ${faults.join(" and ")}`,
          "invalid_value",
        ),
      );
    }
    const { nodeType, problems: typeProblems } = nodeTypeV3(entry);
    let entryProblems = typeProblems;
    if (nodeType === "array") {
      entryProblems = arrayMetadataV3Problems(entry);
    } else if (nodeType === "group") {
      entryProblems = groupMetadataV3Problems(entry);
      const nested = (entry as Record<string, unknown>)[ZARR_V3_CONSOLIDATED_METADATA_KEY];
      if (entryProblems.length === 0 && nested !== undefined) {
        entryProblems = prefix(
          ZARR_V3_CONSOLIDATED_METADATA_KEY,
          consolidatedEntriesV3Problems(nested, depth + 1),
        );
        listings.set(key, (nested as { metadata: Record<string, unknown> }).metadata);
      }
    }
    problems.push(...prefix("metadata", prefix(key, entryProblems)));
    if (faults.length === 0) nodeTypes.set(key, nodeType ?? null);
  }
  const nodes = new Map<string, NodeTypeV3 | null>([["/", "group"]]);
  for (const [key, nodeType] of nodeTypes) nodes.set(`/${key}`, nodeType);
  for (const found of treeProblems(nodes)) {
    problems.push(problem(["metadata", found.path.slice(1)], found.message, found.kind));
  }
  for (const [key, listing] of listings) {
    if (!nodeTypes.has(key)) continue; // a key that is no node path lists nothing
    for (const [path, entry] of Object.entries(listing)) {
      if (belowFaults(path).length > 0) continue; // the nested read reports it
      const joined = `${key}/${path}`;
      const here = ["metadata", key, ZARR_V3_CONSOLIDATED_METADATA_KEY, "metadata", path];
      if (!nodeTypes.has(joined)) {
        problems.push(
          problem(
            here,
            `expected a node the group lists, got ${show(`/${joined}`)}, which ${show(`/${key}`)} lists alone`,
            "invalid_value",
          ),
        );
        continue;
      }
      const flat = nodeTypes.get(joined);
      const nested = nodeTypeV3(entry).nodeType;
      if (flat !== null && flat !== undefined && nested !== undefined && flat !== nested) {
        problems.push(
          problem(
            here,
            `expected ${flat === "array" ? "an array" : "a group"}, as the group lists ${show(`/${joined}`)}, got ${nested === "array" ? "an array" : "a group"}`,
            "invalid_value",
          ),
        );
      }
    }
  }
  return problems;
}

/**
 * Return every reason `value` is not a valid inline `consolidated_metadata`
 * member: its envelope, and each document it lists, read as a v3 array or
 * group document. Locs are value-relative.
 */
function consolidatedMetadataV3Problems(value: unknown): PathedIssue[] {
  return [
    ...consolidatedEnvelopeProblems(value, false),
    ...consolidatedEntriesV3Problems(value, 0),
  ];
}

/**
 * Return every reason `value` is not a structurally-valid v3 group doc.
 *
 * Checks structure, not domain validity. Unknown top-level keys are allowed
 * (extension fields). A `consolidated_metadata` member, if present, is
 * checked against the envelope the core spec fixes; the documents it lists
 * are checked as JSON only (`validateConsolidatedMetadataV3` reads them).
 */
function groupMetadataV3Problems(value: unknown): PathedIssue[] {
  if (!isPlainObject(value)) {
    return [problem([], "expected an object", "invalid_type")];
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
  if (has(doc, ZARR_V3_CONSOLIDATED_METADATA_KEY)) {
    problems.push(
      ...prefix(
        ZARR_V3_CONSOLIDATED_METADATA_KEY,
        consolidatedEnvelopeProblems(doc[ZARR_V3_CONSOLIDATED_METADATA_KEY], true),
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
 * A group's inline consolidated metadata is read in full: each document it
 * lists is checked as `validateConsolidatedMetadataV3` checks it, pathed
 * through `consolidated_metadata`. That is where this dispatcher differs
 * from the reference implementation's node reader, which leaves the listed
 * documents to its consolidated metadata reader; it exists for consumers
 * handed an arbitrary `zarr.json`, like editor tooling.
 */
function metadataV3Problems(value: unknown): PathedIssue[] {
  const { nodeType, problems } = nodeTypeV3(value);
  if (nodeType === "array") return arrayMetadataV3Problems(value);
  if (nodeType === "group") {
    const doc = value as Record<string, unknown>;
    return [
      ...groupMetadataV3Problems(doc),
      ...prefix(
        ZARR_V3_CONSOLIDATED_METADATA_KEY,
        consolidatedEntriesV3Problems(doc[ZARR_V3_CONSOLIDATED_METADATA_KEY], 0),
      ),
    ];
  }
  return problems;
}

/**
 * Return every reason `value` is not a structurally-valid v2 array doc.
 *
 * Checks structure, not domain validity: `dtype` must be a typestr or field
 * records, but which typestrs name real types is not checked; `compressor`
 * and `filters` are required keys that may be `null`, and otherwise must be
 * codec configurations (objects with a string `id`). Members the spec does
 * not define are accepted when they are JSON: other keys "SHOULD NOT be
 * present ... and SHOULD be ignored", unlike `.zgroup`'s "MUST NOT".
 */
function arrayMetadataV2Problems(value: unknown): PathedIssue[] {
  if (!isPlainObject(value)) {
    return [problem([], "expected an object", "invalid_type")];
  }
  const doc = value;
  const problems: PathedIssue[] = missingKeys(ARRAY_METADATA_REQUIRED_KEYS_V2, doc);
  for (const [key, item] of Object.entries(doc)) {
    if (!(ARRAY_METADATA_STANDARD_KEYS_V2 as readonly string[]).includes(key)) {
      problems.push(...prefix(key, jsonProblems(item)));
    }
  }
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
  if (has(doc, "dtype")) {
    problems.push(...prefix("dtype", dtypeV2Problems(doc["dtype"])));
  }
  if (has(doc, "order") && !(ZARR_V2_ARRAY_ORDER as readonly unknown[]).includes(doc["order"])) {
    problems.push(outsideOf(["order"], doc["order"], ZARR_V2_ARRAY_ORDER));
  }
  if (has(doc, "compressor") && doc["compressor"] !== null) {
    problems.push(...prefix("compressor", codecV2Problems(doc["compressor"])));
  }
  if (has(doc, "filters")) {
    const filters = doc["filters"];
    if (filters !== null && !isDenseArray(filters)) {
      problems.push(
        problem(["filters"], "expected null or an array of codec configurations", "invalid_type"),
      );
    } else if (filters !== null) {
      // "a list of JSON objects providing codec configurations, or null"
      // sets no minimum, so an empty list is a pipeline with no filters.
      filters.forEach((item, index) => {
        problems.push(...prefix("filters", prefix(index, codecV2Problems(item))));
      });
    }
  }
  if (
    has(doc, "dimension_separator") &&
    !(ZARR_V2_ARRAY_DIMENSION_SEPARATOR as readonly unknown[]).includes(doc["dimension_separator"])
  ) {
    problems.push(
      outsideOf(["dimension_separator"], doc["dimension_separator"], ZARR_V2_ARRAY_DIMENSION_SEPARATOR),
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
 * `attributes` mapping folded in from `.zattrs`. Other keys "MUST NOT be
 * present", so each one is an `unknown_key`.
 */
function groupMetadataV2Problems(value: unknown): PathedIssue[] {
  if (!isPlainObject(value)) {
    return [problem([], "expected an object", "invalid_type")];
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

const NODE_FILES_V2 = [".zarray", ".zgroup", ".zattrs"] as const;

/**
 * Every structural reason the entries of a `.zmetadata` document (whose own
 * envelope and entries are already JSON) do not hold valid v2 nodes. Each
 * `.zarray` or `.zgroup` entry is read as that document merged with its
 * sibling `.zattrs`, with the attributes' problems located under the
 * `.zattrs` entry; an `attributes` member written in the file itself is a
 * problem, since on disk attributes live in `.zattrs`. A path may hold one
 * node, of one type, and the nodes form a hierarchy rooted at the group
 * the document consolidates. Other entries are left alone.
 */
function consolidatedEntriesV2Problems(entries: Record<string, unknown>): PathedIssue[] {
  const problems: PathedIssue[] = [];
  const byPath = new Map<string, Map<string, string>>();
  for (const key of Object.keys(entries)) {
    const cut = key.lastIndexOf("/");
    const name = key.slice(cut + 1);
    if (!(NODE_FILES_V2 as readonly string[]).includes(name)) continue;
    const segments = (cut < 0 ? "" : key.slice(0, cut)).split("/").filter((part) => part !== "");
    if (segments.some((part) => part === "." || part === "..")) {
      problems.push(
        problem(
          ["metadata", key],
          `expected the path of a node, got ${show(key)}, which has a '.' or '..' segment`,
          "invalid_value",
        ),
      );
      continue;
    }
    const path = segments.join("/");
    const files = byPath.get(path) ?? new Map<string, string>();
    byPath.set(path, files);
    const seen = files.get(name);
    if (seen !== undefined) {
      problems.push(
        problem(
          ["metadata", key],
          `a second ${name} for the node at ${show(path)}, which ${show(seen)} is`,
          "invalid_value",
        ),
      );
      continue;
    }
    files.set(name, key);
  }
  for (const [path, files] of byPath) {
    const zarray = files.get(".zarray");
    const zgroup = files.get(".zgroup");
    const zattrs = files.get(".zattrs");
    if (zarray !== undefined && zgroup !== undefined) {
      problems.push(
        problem(
          ["metadata", zgroup],
          `a node is an array or a group, not both: a .zarray is at ${show(path)} too`,
          "invalid_value",
        ),
      );
      continue;
    }
    const key = zarray ?? zgroup;
    if (key === undefined) continue; // a .zattrs alone forms no node
    const document = entries[key];
    if (!isPlainObject(document)) {
      problems.push(problem(["metadata", key], `expected an object, got ${show(document)}`, "invalid_type"));
      continue;
    }
    const merged: Record<string, unknown> = { ...document };
    if (has(merged, "attributes")) {
      problems.push(
        problem(
          ["metadata", key, "attributes"],
          `unexpected key "attributes" in ${zarray !== undefined ? ".zarray" : ".zgroup"}: ` +
            "attributes belong in .zattrs",
          zarray !== undefined ? "invalid_value" : "unknown_key",
        ),
      );
      delete merged["attributes"];
    }
    if (zattrs !== undefined) merged["attributes"] = entries[zattrs];
    const found = zarray !== undefined ? arrayMetadataV2Problems(merged) : groupMetadataV2Problems(merged);
    for (const issue of found) {
      problems.push(
        zattrs !== undefined && issue.path[0] === "attributes"
          ? { ...issue, path: ["metadata", zattrs, ...issue.path.slice(1)] }
          : { ...issue, path: ["metadata", key, ...issue.path] },
      );
    }
  }
  // The root is a group unless an entry says otherwise: a `.zmetadata`
  // does not have to list its own `.zgroup`.
  const nodes = new Map<string, NodeTypeV3 | null>([["/", "group"]]);
  for (const [path, files] of byPath) {
    if (files.has(".zarray")) nodes.set(`/${path}`, "array");
    else if (files.has(".zgroup")) nodes.set(`/${path}`, "group");
  }
  for (const found of treeProblems(nodes)) {
    const path = found.path.slice(1);
    const files = byPath.get(path);
    const key =
      files?.get(".zarray") ?? files?.get(".zgroup") ?? (path === "" ? ".zgroup" : `${path}/.zgroup`);
    problems.push(problem(["metadata", key], found.message, found.kind));
  }
  return problems;
}

/**
 * Return every reason `value` is not a structurally-valid `.zmetadata` doc
 * (v2 consolidated metadata): its envelope, each entry as JSON (a `.zattrs`
 * entry as attributes), and, when all of that holds, the nodes its entries
 * describe, as `consolidatedEntriesV2Problems` reads them.
 */
function consolidatedMetadataV2Problems(value: unknown): PathedIssue[] {
  if (!isPlainObject(value)) {
    return [problem([], "expected an object", "invalid_type")];
  }
  const doc = value;
  const problems: PathedIssue[] = ["zarr_consolidated_format", "metadata"]
    .filter((key) => !(has(doc, key)))
    .map((key) => problem([key], "missing required key", "missing_key"));
  problems.push(...unexpectedKeys(["zarr_consolidated_format", "metadata"], doc));
  problems.push(...checkLiteral(doc, "zarr_consolidated_format", 1));
  const entries = doc["metadata"];
  if (has(doc, "metadata")) {
    if (!isPlainObject(entries)) {
      problems.push(problem(["metadata"], "expected an object with string keys", "invalid_type"));
    } else {
      for (const [key, item] of Object.entries(entries)) {
        problems.push(...prefix("metadata", prefix(key, jsonProblems(item))));
      }
    }
  }
  // The nodes are read only from a document whose envelope and entries hold.
  if (problems.length === 0 && isPlainObject(entries)) {
    problems.push(...consolidatedEntriesV2Problems(entries));
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
export function loadStoreJson(mapping: StoreMapping, key: string): unknown {
  const raw = storeGet(mapping, key);
  if (raw === undefined) {
    throw new MetadataValidationError(treeOf([problem([key], "missing store key", "missing_key")]));
  }
  try {
    const text =
      typeof raw === "string" ? raw : new TextDecoder("utf-8", { fatal: true }).decode(raw);
    return JSON.parse(text);
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
 * a non-JSON value — a non-finite number, a `Map`, a `BigInt` — throws
 * `MetadataValidationError` instead of being silently rewritten to `null`
 * the way bare `JSON.stringify` would.
 */
export function dumpStoreJson(
  value: unknown,
  options: { indent?: number | string } = {},
): Uint8Array {
  const problems = jsonProblems(value);
  if (problems.length > 0) throw new MetadataValidationError(treeOf(problems));
  return new TextEncoder().encode(JSON.stringify(value, null, options.indent));
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
 * The node problems of a `.zmetadata` document's entries: each `.zarray`
 * and `.zgroup` entry read as an on-disk document merged with its sibling
 * `.zattrs`, and the hierarchy they form.
 *
 * @deprecated `validateConsolidatedMetadataV2` now reads the entries too,
 * as the reference implementation does, and reports these same problems
 * whenever the envelope and entries are JSON. This function reports them
 * even when the envelope has problems of its own.
 */
export function validateConsolidatedDocumentsV2(value: unknown): ErrorTree {
  if (!isPlainObject(value)) return treeOf([]);
  const entries = value["metadata"];
  if (!isPlainObject(entries)) return treeOf([]);
  return treeOf(consolidatedEntriesV2Problems(entries));
}
