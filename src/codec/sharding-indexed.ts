/** The core `sharding_indexed` codec. */
import {
  configured,
  field,
  type AcceptedField,
  type Chunk,
  type CodecDefinition,
  type Lengths,
} from "../definition.js";
import type { PathedIssue } from "../errors.js";
import { integerIn, issue, oneOf, optional, required, sequenceOf } from "../typed.js";
import { uint64 } from "../data-type/uint64.js";

/** Configuration of the core `sharding_indexed` codec. */
export interface ShardingIndexedCodecConfiguration {
  chunk_shape: number[];
  codecs: unknown[];
  index_codecs: unknown[];
  index_location?: "start" | "end";
}

/** The data type of a shard index, which the spec fixes. */
const UINT64: AcceptedField = {
  status: "accepted",
  json: "uint64",
  name: "uint64",
  definition: uint64,
  configuration: {},
  nested: new Map(),
};

/** The number of inner chunks a shard holds along each axis; undefined where unknown. */
function perShard(chunkShape: readonly number[], lengths: Lengths | undefined): Lengths {
  if (lengths === undefined) return chunkShape.map(() => undefined);
  return chunkShape.map((inner, axis) => {
    const shard = lengths[axis];
    if (shard === undefined || shard.some((length) => length % inner !== 0)) return undefined;
    return [...new Set(shard.map((length) => length / inner))];
  });
}

/**
 * "The length of the chunk_shape array must match the number of dimensions
 * of the shard shape to which this sharding codec is applied, and the inner
 * chunk shape along each dimension must evenly divide the size of the shard
 * shape." The shard is the chunk the codec receives, so a transposed shard
 * is divided along its transposed axes. The inner codecs receive the inner
 * chunks, of the shard's data type; the index codecs receive the shard
 * index, of `uint64`, with an axis of length 2 appended, and may hold only
 * codecs of static size, since a reader locates the index by its size.
 */
export const shardingIndexed: CodecDefinition<ShardingIndexedCodecConfiguration> = {
  name: "sharding_indexed",
  ...configured({
    chunk_shape: required(sequenceOf(integerIn({ ge: 1 }))),
    codecs: required(sequenceOf(field("codec"))),
    index_codecs: required(sequenceOf(field("codec", { staticOnly: true }))),
    index_location: optional(oneOf(["start", "end"])),
  }),
  kind: "array_bytes",
  size: "dynamic",
  chunkRules: ({ chunk_shape }, _nested, chunk) => {
    const lengths = chunk.lengths;
    if (lengths === undefined) return [];
    if (chunk_shape.length !== lengths.length) {
      return [
        issue(
          ["chunk_shape"],
          `expected ${lengths.length} inner chunk lengths, one per axis of the chunk the codec is handed, got ${chunk_shape.length}`,
          "invalid_value",
        ),
      ];
    }
    const issues: PathedIssue[] = [];
    chunk_shape.forEach((inner, axis) => {
      const undivided = (lengths[axis] ?? []).filter((length) => length % inner !== 0);
      if (undivided.length > 0) {
        issues.push(
          issue(
            ["chunk_shape", axis],
            "expected an inner chunk length that divides each length the shards take along this axis, " +
              `got ${inner}, which does not divide ${Math.min(...undivided)}`,
            "invalid_value",
          ),
        );
      }
    });
    return issues;
  },
  pipelines: ({ chunk_shape }, _nested, chunk): Record<string, Chunk> => {
    const lengths = chunk.lengths;
    // Which of the two disagrees is unknown, so both pipelines receive
    // chunks of unknown lengths.
    if (lengths !== undefined && lengths.length !== chunk_shape.length) {
      return {
        codecs: { lengths: undefined, dataType: chunk.dataType },
        index_codecs: { lengths: undefined, dataType: UINT64 },
      };
    }
    return {
      codecs: { lengths: chunk_shape.map((length) => [length]), dataType: chunk.dataType },
      index_codecs: { lengths: [...perShard(chunk_shape, lengths), [2]], dataType: UINT64 },
    };
  },
};
