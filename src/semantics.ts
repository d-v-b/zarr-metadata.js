/**
 * Semantic validation for v3 metadata: what the names in a document mean.
 * A port of the rules the reference implementation's v3 readers apply in
 * their default scope (`CORE_AND_EXTENSIONS`), on top of the structural
 * checks in `validation.ts`; the two together report what those readers
 * report, which the conformance corpus asserts.
 *
 * Each extension point is read through the definition that claims its
 * name (`definition.ts`; one module per name under `chunk-grid/`,
 * `chunk-key-encoding/`, `codec/` and `data-type/`): its configuration is
 * checked, and the fields nested in it are read the same way. Then the
 * cross-field rules run on what was read: the fill value against the data
 * type, the chunk grid against the shape, and the codecs as a pipeline,
 * each against the chunk it receives (`codec/pipeline.ts`). A name nothing
 * in scope claims is left unjudged — the extension name space is open —
 * and so is everything that would depend on it.
 */
import { CHUNK_GRIDS } from "./chunk-grid/index.js";
import { CHUNK_KEY_ENCODINGS } from "./chunk-key-encoding/index.js";
import { CODECS } from "./codec/index.js";
import { pipelineProblems } from "./codec/pipeline.js";
import { DATA_TYPES } from "./data-type/index.js";
import {
  chunkGridLengths,
  fillValueProblems,
  prefixed,
  readField,
  type Definition,
  type FieldKind,
  type Lengths,
  type ResolvedField,
  type Scope,
} from "./definition.js";
import { flattenTree, treeOf, type ErrorTree, type PathedIssue } from "./errors.js";
import { isIntArray, isPlainObject } from "./guards.js";
import { isJson, validateGroupMetadataV3 } from "./validation.js";

function byName<D extends Definition>(definitions: readonly D[]): ReadonlyMap<string, D> {
  return new Map(definitions.map((definition) => [definition.name, definition]));
}

/** The definitions the semantic layer reads with: the reference implementation's `CORE_AND_EXTENSIONS`. */
const SCOPE: Scope = {
  data_type: byName(DATA_TYPES),
  chunk_grid: byName(CHUNK_GRIDS),
  chunk_key_encoding: byName(CHUNK_KEY_ENCODINGS),
  codec: byName(CODECS),
};

const SINGLE_FIELDS: ReadonlyArray<[string, FieldKind]> = [
  ["data_type", "data_type"],
  ["chunk_grid", "chunk_grid"],
  ["chunk_key_encoding", "chunk_key_encoding"],
];

function arraySemanticsIssues(doc: Record<string, unknown>): PathedIssue[] {
  const issues: PathedIssue[] = [];
  const has = (key: string): boolean => Object.hasOwn(doc, key);
  const shapeValue = doc["shape"];
  const shape =
    isIntArray(shapeValue) && shapeValue.every((length) => length >= 0) ? shapeValue : undefined;
  const read: Partial<Record<string, ResolvedField>> = {};
  for (const [key, kind] of SINGLE_FIELDS) {
    // A member that is not JSON is the structural layer's problem, and is not read.
    if (!has(key) || !isJson(doc[key])) continue;
    const result = readField(doc[key], kind, [key], SCOPE);
    read[key] = result.field;
    issues.push(...result.issues);
  }
  if (has("fill_value") && isJson(doc["fill_value"]) && read["data_type"] !== undefined) {
    issues.push(...fillValueProblems(read["data_type"], doc["fill_value"], ["fill_value"]));
  }
  // The grid gives the chunk lengths the first codec receives: one entry
  // per dimension, undefined where unknown.
  let lengths: Lengths | undefined = shape?.map(() => undefined);
  const grid = read["chunk_grid"];
  if (grid !== undefined && shape !== undefined) {
    const result = chunkGridLengths(grid, shape, ["chunk_grid"]);
    lengths = result.lengths;
    issues.push(...result.issues);
  }
  const codecs = doc["codecs"];
  if (Array.isArray(codecs)) {
    const fields = codecs.map((entry, index): ResolvedField => {
      if (!isJson(entry)) {
        return { status: "refused", json: entry, name: undefined, definition: undefined, nested: new Map() };
      }
      const result = readField(entry, "codec", ["codecs", index], SCOPE);
      issues.push(...result.issues);
      return result.field;
    });
    issues.push(
      ...pipelineProblems(fields, { lengths, dataType: read["data_type"] }, ["codecs"], { checkEmpty: false }),
    );
  }
  return issues;
}

/**
 * Every semantic problem in a v3 array metadata document, as an error
 * tree; an empty tree means no rule found a violation. A value that is not
 * an object yields an empty tree; run the structural validators for
 * structure. See `validateSemanticsV3` for the form that dispatches on
 * `node_type` and also reads a group's inline consolidated metadata.
 */
export function validateArraySemanticsV3(value: unknown): ErrorTree {
  return treeOf(isPlainObject(value) ? arraySemanticsIssues(value) : []);
}

// Matches the structural validators' MAX_JSON_DEPTH; the structural layer
// reports the depth violation, this layer just stops descending.
const MAX_CONSOLIDATED_DEPTH = 64;

/**
 * The semantic problems of the documents a `consolidated_metadata` member
 * lists, located in the member. A listed group's own listing is read too,
 * as the reference implementation reads it: only when the group has no
 * problem of its own.
 */
function consolidatedSemanticsIssues(value: unknown, depth: number): PathedIssue[] {
  if (depth >= MAX_CONSOLIDATED_DEPTH || !isPlainObject(value)) return [];
  const entries = value["metadata"];
  if (!isPlainObject(entries)) return [];
  const issues: PathedIssue[] = [];
  for (const [key, entry] of Object.entries(entries)) {
    if (!isPlainObject(entry)) continue;
    if (entry["node_type"] === "array") {
      issues.push(...prefixed(["metadata", key], arraySemanticsIssues(entry)));
    } else if (
      entry["node_type"] === "group" &&
      Object.hasOwn(entry, "consolidated_metadata") &&
      flattenTree(validateGroupMetadataV3(entry)).length === 0
    ) {
      issues.push(
        ...prefixed(
          ["metadata", key, "consolidated_metadata"],
          consolidatedSemanticsIssues(entry["consolidated_metadata"], depth + 1),
        ),
      );
    }
  }
  return issues;
}

/**
 * Every semantic problem in a v3 metadata document of either node type:
 * an array document gets the array rules, and the documents a group's
 * inline consolidated metadata lists are checked too (each entry is a
 * complete array or group document, and listed groups may list documents
 * of their own). Issues inside entries are pathed through
 * `consolidated_metadata.metadata.<key>`.
 */
export function validateSemanticsV3(value: unknown): ErrorTree {
  if (!isPlainObject(value)) return treeOf([]);
  if (value["node_type"] === "array") return treeOf(arraySemanticsIssues(value));
  if (value["node_type"] !== "group") return treeOf([]);
  return treeOf(
    prefixed(["consolidated_metadata"], consolidatedSemanticsIssues(value["consolidated_metadata"], 1)),
  );
}
