/** The core `transpose` codec. */
import { configured, type CodecDefinition } from "../definition.js";
import { integer, issue, required, sequenceOf, show } from "../typed.js";

/** Configuration of the core `transpose` codec. */
export interface TransposeCodecConfiguration {
  order: number[];
}

/**
 * `order` is "a permutation of 0, 1, ..., n-1, where n is the number of
 * dimensions in the decoded chunk representation provided as input to
 * this codec", and the output has "B_shape[i] = A_shape[order[i]]".
 */
export const transpose: CodecDefinition<TransposeCodecConfiguration> = {
  name: "transpose",
  ...configured({ order: required(sequenceOf(integer)) }),
  kind: "array_array",
  size: "static",
  rules: ({ order }) => {
    const sorted = [...order].sort((a, b) => a - b);
    return sorted.every((axis, index) => axis === index)
      ? []
      : [issue(["order"], `expected a permutation of 0..${order.length - 1}, got ${show(order)}`, "invalid_value")];
  },
  chunkRules: ({ order }, _nested, chunk) =>
    chunk.lengths !== undefined && order.length !== chunk.lengths.length
      ? [
          issue(
            ["order"],
            `expected ${chunk.lengths.length} entries, one per axis of the chunk the codec is handed, got ${order.length}`,
            "invalid_value",
          ),
        ]
      : [],
  transition: ({ order }, _nested, chunk) => {
    const lengths = chunk.lengths;
    if (lengths === undefined || order.length !== lengths.length) {
      return { lengths: undefined, dataType: chunk.dataType };
    }
    return { lengths: order.map((axis) => lengths[axis]), dataType: chunk.dataType };
  },
};
