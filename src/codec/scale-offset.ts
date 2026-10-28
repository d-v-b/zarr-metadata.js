/** The zarr-extensions `scale_offset` codec. */
import { configured, fillValueProblems, type CodecDefinition } from "../definition.js";
import type { PathedIssue } from "../errors.js";
import { issue, json, optional, show } from "../typed.js";
import { NOT_NUMBERS } from "./arithmetic.js";

/** Configuration of the zarr-extensions `scale_offset` codec; each scalar is a fill value of the input data type. */
export interface ScaleOffsetCodecConfiguration {
  offset?: unknown;
  scale?: unknown;
}

/**
 * The codec "is only defined for data types where multiplication,
 * division, addition, and subtraction are well-defined", and each of
 * `offset` and `scale` "MUST be encoded to JSON using the Zarr V3 fill
 * value encoding for the input array's data type". Its output has the
 * input's shape and data type.
 */
export const scaleOffset: CodecDefinition<ScaleOffsetCodecConfiguration> = {
  name: "scale_offset",
  ...configured({ offset: optional(json), scale: optional(json) }),
  kind: "array_array",
  size: "static",
  rules: (configuration) =>
    (["offset", "scale"] as const)
      .filter((member) => Object.hasOwn(configuration, member) && configuration[member] === null)
      .map((member) => issue([member], "expected a scalar, got null", "invalid_value")),
  chunkRules: (configuration, _nested, chunk) => {
    const source = chunk.dataType;
    if (source?.status !== "accepted") return [];
    if (NOT_NUMBERS.has(source.definition.name)) {
      return [
        issue([], `expected a chunk of a data type with arithmetic, got ${show(source.name)}`, "invalid_value"),
      ];
    }
    const issues: PathedIssue[] = [];
    for (const member of ["offset", "scale"] as const) {
      const value = configuration[member];
      if (value !== undefined && value !== null) issues.push(...fillValueProblems(source, value, [member]));
    }
    return issues;
  },
  transition: (_configuration, _nested, chunk) => chunk,
};
