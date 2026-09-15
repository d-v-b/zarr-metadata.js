/** The zarr-extensions `rectilinear` chunk grid: syntax and semantics. */
import type { PathedIssue } from "../errors.js";
import { configurationMissing, fieldParts, isIntArray } from "../guards.js";
import type { ChunkGridVerdict } from "./index.js";

/**
 * One dimension's spec in a rectilinear grid: a bare integer (uniform
 * shorthand, no sum constraint) or a list of chunk sizes and
 * `[size, count]` run-length pairs that must sum to at least the dimension
 * length (overflowing it, e.g. after the array shrinks, is permitted).
 */
export type RectilinearDimSpec = number | Array<number | [number, number]>;

/** Configuration of the zarr-extensions `rectilinear` chunk grid. */
export interface RectilinearChunkGridConfiguration {
  kind: "inline";
  chunk_shapes: RectilinearDimSpec[];
}

export function rectilinearIssues(rawGrid: unknown, shape: number[] | undefined): ChunkGridVerdict {
  const issues: PathedIssue[] = [];
  let chunkSizes: number[][] | undefined;
  const configuration = fieldParts(rawGrid)?.configuration;
  if (configurationMissing(rawGrid)) {
    issues.push({
      path: [],
      message: '"rectilinear" requires a configuration with "kind" and "chunk_shapes"',
      kind: "missing_key",
    });
  } else if (configuration !== undefined) {
    for (const key of ["kind", "chunk_shapes"]) {
      if (!Object.hasOwn(configuration, key)) {
        issues.push({
          path: ["configuration", key],
          message: "missing required key",
          kind: "missing_key",
        });
      }
    }
  }
  const specs = configuration?.["chunk_shapes"];
  if (Array.isArray(specs)) {
    if (shape !== undefined && specs.length !== shape.length) {
      issues.push({
        path: ["configuration", "chunk_shapes"],
        message: `expected one entry per dimension of shape (${shape.length})`,
        kind: "invalid_value",
      });
    } else {
      const perDim: (number[] | undefined)[] = specs.map((spec, dim) => {
        // Bare integer: uniform shorthand, no sum constraint (edge chunks
        // are permitted, as with the regular grid).
        if (Number.isInteger(spec)) return (spec as number) > 0 ? [spec as number] : undefined;
        if (!Array.isArray(spec)) return undefined; // registry schema's problem
        const sizes = new Set<number>();
        let total = 0;
        for (const entry of spec) {
          if (Number.isInteger(entry)) {
            sizes.add(entry as number);
            total += entry as number;
          } else if (
            Array.isArray(entry) &&
            entry.length === 2 &&
            Number.isInteger(entry[0]) &&
            Number.isInteger(entry[1])
          ) {
            sizes.add(entry[0] as number);
            total += (entry[0] as number) * (entry[1] as number);
          } else {
            return undefined; // malformed entry: registry schema's problem
          }
        }
        const extent = shape?.[dim];
        // "The sum of the edge lengths MUST equal or exceed L. Overflowing L
        // by multiple chunks is permitted."
        if (extent !== undefined && total < extent) {
          issues.push({
            path: ["configuration", "chunk_shapes", dim],
            message: `expected chunk sizes summing to at least ${extent} along dimension ${dim}, got ${total}`,
            kind: "invalid_value",
          });
        }
        return [...sizes];
      });
      if (perDim.every((sizes) => sizes !== undefined)) {
        chunkSizes = perDim as number[][];
      }
    }
  }
  return { issues, chunkSizes };
}
