/** The core `regular` chunk grid. */
import { configured, type ChunkGridDefinition } from "../definition.js";
import { integerIn, issue, required, sequenceOf } from "../typed.js";

/** Configuration of the core `regular` chunk grid. */
export interface RegularChunkGridConfiguration {
  chunk_shape: number[];
}

/**
 * Every chunk length is at least 1, even along a dimension of length 0
 * ("Chunk sizes must be greater than zero"), and there is one per
 * dimension of the array. Every chunk, the edge ones included, has the
 * grid's `chunk_shape`.
 */
export const regular: ChunkGridDefinition<RegularChunkGridConfiguration> = {
  name: "regular",
  ...configured({ chunk_shape: required(sequenceOf(integerIn({ ge: 1 }))) }),
  shapeRules: ({ chunk_shape }, _nested, shape) =>
    chunk_shape.length === shape.length
      ? []
      : [
          issue(
            ["chunk_shape"],
            `expected one chunk length per dimension of shape, got ${chunk_shape.length}`,
            "invalid_value",
          ),
        ],
  chunkLengths: ({ chunk_shape }) => chunk_shape.map((length) => [length]),
};
