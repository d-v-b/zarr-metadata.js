/** The zarr-extensions `rectilinear` chunk grid. */
import { configured, type ChunkGridDefinition } from "../definition.js";
import type { PathedIssue } from "../errors.js";
import { anyOf, fixedTuple, integerIn, issue, oneOf, required, sequenceOf } from "../typed.js";

/**
 * One dimension's spec in a rectilinear grid: a bare integer (a step that
 * repeats until it covers the dimension) or a list of chunk lengths and
 * `[length, count]` run-length pairs. Every length and count is at least 1.
 */
export type RectilinearDimSpec = number | Array<number | [number, number]>;

/** Configuration of the zarr-extensions `rectilinear` chunk grid. */
export interface RectilinearChunkGridConfiguration {
  kind: "inline";
  chunk_shapes: RectilinearDimSpec[];
}

const POSITIVE = integerIn({ ge: 1 });
const PAIR = fixedTuple([POSITIVE, POSITIVE], "a [an integer, an integer] pair");
const ENTRY = anyOf(
  [
    { shape: "int", parse: POSITIVE },
    { shape: "tuple", parse: PAIR },
  ],
  "an integer or a [an integer, an integer] pair",
);
const DIM_SPEC = anyOf(
  [
    { shape: "int", parse: POSITIVE },
    { shape: "tuple", parse: sequenceOf(ENTRY) },
  ],
  "an integer or an array of chunk lengths",
);

function entryLength(entry: number | [number, number]): number {
  return typeof entry === "number" ? entry : entry[0];
}

/**
 * "The length of `chunk_shapes` MUST match the number of dimensions of the
 * array", and "The sum of the edge lengths MUST equal or exceed `L`":
 * chunks past the array's edge are allowed, which the array grows into
 * when it is resized. A bare integer always covers its dimension. Every
 * listed length counts for what a sharding codec must divide.
 */
export const rectilinear: ChunkGridDefinition<RectilinearChunkGridConfiguration> = {
  name: "rectilinear",
  ...configured({
    kind: required(oneOf(["inline"])),
    chunk_shapes: required(sequenceOf(DIM_SPEC)),
  }),
  shapeRules: ({ chunk_shapes }, _nested, shape) => {
    if (chunk_shapes.length !== shape.length) {
      return [
        issue(
          ["chunk_shapes"],
          `expected one chunk_shapes entry per dimension of shape, got ${chunk_shapes.length}`,
          "invalid_value",
        ),
      ];
    }
    const issues: PathedIssue[] = [];
    chunk_shapes.forEach((spec, axis) => {
      if (typeof spec === "number") return;
      const covered = spec.reduce<number>(
        (total, entry) => total + (typeof entry === "number" ? entry : entry[0] * entry[1]),
        0,
      );
      const extent = shape[axis] as number;
      if (covered < extent) {
        issues.push(
          issue(
            ["chunk_shapes", axis],
            `expected chunk lengths that cover the dimension's length ${extent}, got lengths summing to ${covered}`,
            "invalid_value",
          ),
        );
      }
    });
    return issues;
  },
  chunkLengths: ({ chunk_shapes }) =>
    chunk_shapes.map((spec) =>
      typeof spec === "number" ? [spec] : [...new Set(spec.map(entryLength))],
    ),
};
