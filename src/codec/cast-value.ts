/** The zarr-extensions `cast_value` codec. */
import {
  configured,
  field,
  fillValueProblems,
  nestedAt,
  type CodecDefinition,
} from "../definition.js";
import type { PathedIssue } from "../errors.js";
import { fixedTuple, issue, json, objectOf, oneOf, optional, required, sequenceOf, show } from "../typed.js";
import { COMPLEX, FLOATING_POINT, NOT_NUMBERS } from "./arithmetic.js";

/** An `[input, output]` scalar mapping, each written as a fill value of its side's data type. */
export type ScalarMapEntry = [unknown, unknown];

/** Configuration of the zarr-extensions `cast_value` codec. */
export interface CastValueCodecConfiguration {
  /** The target data type, a data type field like the array's own. */
  data_type: unknown;
  rounding?: "nearest-even" | "towards-zero" | "towards-positive" | "towards-negative" | "nearest-away";
  out_of_range?: "clamp" | "wrap";
  scalar_map?: { encode?: ScalarMapEntry[]; decode?: ScalarMapEntry[] };
}

const NO_REAL_NUMBERS: ReadonlySet<string> = new Set([...NOT_NUMBERS, ...COMPLEX]);
const ENTRY = fixedTuple([json, json], "an [input, output] pair");

/**
 * Each scalar of `scalar_map` written in the data type of one side, with its
 * location: "For encode, the input data type is the array data type before
 * casting and the output data type is the target data_type. For decode,
 * the input data type is the target data_type and the output data type is
 * the array data type before casting."
 */
function scalars(
  configuration: CastValueCodecConfiguration,
  side: "source" | "target",
): Array<{ path: Array<string | number>; value: unknown }> {
  const found: Array<{ path: Array<string | number>; value: unknown }> = [];
  for (const direction of ["encode", "decode"] as const) {
    const at = Number((direction === "encode") === (side === "target"));
    (configuration.scalar_map?.[direction] ?? []).forEach((entry, index) => {
      found.push({ path: ["scalar_map", direction, index, at], value: entry[at] });
    });
  }
  return found;
}

/**
 * The codec "is only defined for data types that model real numbers", on
 * either side, and `wrap` is "Only permitted when data_type is an integral
 * type". The output chunk has the target data type, as the scope read it.
 */
export const castValue: CodecDefinition<CastValueCodecConfiguration> = {
  name: "cast_value",
  ...configured({
    data_type: required(field("data_type")),
    rounding: optional(
      oneOf(["nearest-even", "towards-zero", "towards-positive", "towards-negative", "nearest-away"]),
    ),
    out_of_range: optional(oneOf(["clamp", "wrap"])),
    scalar_map: optional(
      objectOf({ encode: optional(sequenceOf(ENTRY)), decode: optional(sequenceOf(ENTRY)) }),
    ),
  }),
  kind: "array_array",
  size: "static",
  rules: (configuration, nested) => {
    const target = nestedAt(nested, "data_type");
    if (target?.status !== "accepted") return [];
    const name = target.definition.name;
    if (NO_REAL_NUMBERS.has(name)) {
      return [
        issue(["data_type"], `expected a data type that models real numbers, got ${show(target.name)}`, "invalid_value"),
      ];
    }
    const issues: PathedIssue[] = [];
    if (configuration.out_of_range === "wrap" && FLOATING_POINT.has(name)) {
      issues.push(
        issue(["out_of_range"], `expected an integral data_type to wrap to, got ${show(target.name)}`, "invalid_value"),
      );
    }
    for (const { path, value } of scalars(configuration, "target")) {
      issues.push(...fillValueProblems(target, value, path));
    }
    return issues;
  },
  chunkRules: (configuration, _nested, chunk) => {
    const source = chunk.dataType;
    if (source?.status !== "accepted") return [];
    if (NO_REAL_NUMBERS.has(source.definition.name)) {
      return [
        issue(
          [],
          `expected a chunk of a data type that models real numbers, got ${show(source.name)}`,
          "invalid_value",
        ),
      ];
    }
    return scalars(configuration, "source").flatMap(({ path, value }) => fillValueProblems(source, value, path));
  },
  transition: (_configuration, nested, chunk) => ({
    lengths: chunk.lengths,
    dataType: nestedAt(nested, "data_type"),
  }),
};
