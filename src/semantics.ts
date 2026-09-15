/**
 * Semantic (cross-field) validation for array metadata: the
 * orchestrator. The rules themselves live with their content —
 * `chunk-grid/`, `codec/`, and `data-type/` hold one module per
 * interpreted name (grids, codecs, data types), each with its syntax
 * (types) and semantics (procedures), mirroring how the spec, the Python
 * reference's type layout, and the zarr-extensions registry are organized. This module only walks
 * documents: extract shape, ask each content module for its verdicts,
 * thread the chunk-size context into codec pipelines, and descend into a
 * group's inline consolidated entries. For v2, `data-type/numpy-typestr`
 * interprets `dtype` contents and `fill_value` encodings, and this module
 * applies them to a `.zarray` document or the `.zarray` entries of a
 * `.zmetadata` document.
 *
 * Unrecognized names are skipped everywhere — the extension name space is
 * open, and a rule that guessed would lie. This layer has no counterpart
 * in the Python reference implementation (which stops at structure), so it
 * is covered by this package's own tests rather than the conformance
 * corpus. The structural document layer (validation.ts) stays
 * content-agnostic and corpus-governed; it never reads the content
 * modules.
 */

import { chunkGridVerdict } from "./chunk-grid/index.js";
import { pipelineIssues } from "./codec/index.js";
import { dataTypeVerdict } from "./data-type/index.js";
import { dtypeIssuesV2, fillIssuesV2 } from "./data-type/numpy-typestr.js";
import { treeOf, type ErrorTree, type PathedIssue } from "./errors.js";
import { isIntArray, isPlainObject } from "./guards.js";

function arraySemanticsIssues(value: unknown): PathedIssue[] {
  if (!isPlainObject(value) || value["node_type"] !== "array") return [];
  const issues: PathedIssue[] = [];
  const shape = isIntArray(value["shape"]) ? value["shape"] : undefined;

  const grid = chunkGridVerdict(value["chunk_grid"], shape);
  issues.push(
    ...grid.issues.map((issue) => ({ ...issue, path: ["chunk_grid", ...issue.path] })),
  );

  issues.push(...dataTypeVerdict(value["data_type"], "fill_value" in value, value["fill_value"]));

  const codecs = value["codecs"];
  if (Array.isArray(codecs)) {
    issues.push(...pipelineIssues(codecs, ["codecs"], shape?.length, grid.chunkSizes));
  }
  return issues;
}

/**
 * Every semantic (cross-field) problem in a v3 array metadata document, as
 * an error tree; an empty tree means no rule found a violation. Values that
 * are not v3 array documents yield an empty tree; run the structural
 * validators for structure. See `validateSemanticsV3` for the form that
 * also descends into a group's inline consolidated metadata.
 */
export function validateArraySemanticsV3(value: unknown): ErrorTree {
  return treeOf(arraySemanticsIssues(value));
}

// Matches the structural validators' MAX_JSON_DEPTH; the structural layer
// reports the depth violation, this layer just stops descending.
const MAX_CONSOLIDATED_DEPTH = 64;

function semanticsIssuesAtDepth(value: unknown, depth: number): PathedIssue[] {
  if (depth >= MAX_CONSOLIDATED_DEPTH || !isPlainObject(value)) return [];
  if (value["node_type"] === "array") return arraySemanticsIssues(value);
  if (value["node_type"] !== "group") return [];
  const consolidated = value["consolidated_metadata"];
  if (!isPlainObject(consolidated)) return [];
  const entries = consolidated["metadata"];
  if (!isPlainObject(entries)) return [];
  const issues: PathedIssue[] = [];
  for (const [key, entry] of Object.entries(entries)) {
    issues.push(
      ...semanticsIssuesAtDepth(entry, depth + 1).map((issue) => ({
        ...issue,
        path: ["consolidated_metadata", "metadata", key, ...issue.path],
      })),
    );
  }
  return issues;
}

/**
 * Every semantic problem in a v3 metadata document of either node type: an
 * array document gets the array rules, and a group document's inline
 * consolidated entries are checked recursively (each entry is a complete
 * array or group document, and nested groups may carry consolidated
 * metadata of their own). Issues inside entries are pathed through
 * `consolidated_metadata.metadata.<key>`.
 */
export function validateSemanticsV3(value: unknown): ErrorTree {
  return treeOf(semanticsIssuesAtDepth(value, 0));
}

// --- v2 --------------------------------------------------------------------

function arraySemanticsIssuesV2(value: unknown): PathedIssue[] {
  if (!isPlainObject(value)) return [];
  const issues: PathedIssue[] = [];
  const dtype = value["dtype"];
  issues.push(...dtypeIssuesV2(dtype).map((issue) => ({ ...issue, path: ["dtype", ...issue.path] })));
  if (Object.hasOwn(value, "fill_value")) {
    issues.push(
      ...fillIssuesV2(dtype, value["fill_value"]).map((issue) => ({
        ...issue,
        path: ["fill_value", ...issue.path],
      })),
    );
  }
  return issues;
}

/**
 * Every semantic problem in a v2 array metadata document (`.zarray`): the
 * `dtype` typestr grammar (byte order, kind code, NumPy item size, datetime
 * units), structured-dtype field rules, and the `fill_value` encoding the
 * spec fixes for the data type. An empty tree means no rule found a
 * violation; run the structural validators for structure.
 */
export function validateArraySemanticsV2(value: unknown): ErrorTree {
  return treeOf(arraySemanticsIssuesV2(value));
}

/**
 * `validateArraySemanticsV2` for a `.zarray` document, or — for a
 * `.zmetadata` document (recognized by its `zarr_consolidated_format`
 * member) — for each `.zarray` entry of its `metadata` map, pathed through
 * `metadata.<key>`.
 */
export function validateSemanticsV2(value: unknown): ErrorTree {
  if (!isPlainObject(value)) return treeOf([]);
  if (!Object.hasOwn(value, "zarr_consolidated_format")) return validateArraySemanticsV2(value);
  const entries = value["metadata"];
  if (!isPlainObject(entries)) return treeOf([]);
  const issues: PathedIssue[] = [];
  for (const [key, entry] of Object.entries(entries)) {
    if (key !== ".zarray" && !key.endsWith("/.zarray")) continue;
    issues.push(
      ...arraySemanticsIssuesV2(entry).map((issue) => ({
        ...issue,
        path: ["metadata", key, ...issue.path],
      })),
    );
  }
  return treeOf(issues);
}
