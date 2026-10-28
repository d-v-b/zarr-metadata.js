/** The core `blosc` codec. */
import { configured, type CodecDefinition } from "../definition.js";
import { integer, integerIn, issue, oneOf, optional, required } from "../typed.js";

/** Configuration of the core `blosc` codec. */
export interface BloscCodecConfiguration {
  cname: "lz4" | "lz4hc" | "blosclz" | "snappy" | "zlib" | "zstd";
  clevel: number;
  shuffle: "noshuffle" | "shuffle" | "bitshuffle";
  blocksize: number;
  /** Required, and positive, unless `shuffle` is `"noshuffle"`. */
  typesize?: number;
}

export const blosc: CodecDefinition<BloscCodecConfiguration> = {
  name: "blosc",
  ...configured({
    cname: required(oneOf(["lz4", "lz4hc", "blosclz", "snappy", "zlib", "zstd"])),
    clevel: required(integerIn({ ge: 0, le: 9 })),
    shuffle: required(oneOf(["noshuffle", "shuffle", "bitshuffle"])),
    blocksize: required(integerIn({ ge: 0 })),
    typesize: optional(integer),
  }),
  kind: "bytes_bytes",
  size: "dynamic",
  // The spec requires `typesize` "unless `shuffle` is `"noshuffle"`, in
  // which case the value is ignored".
  rules: ({ shuffle, typesize }) => {
    if (shuffle === "noshuffle") return [];
    if (typesize === undefined) {
      return [issue(["typesize"], `typesize is required when shuffle is "${shuffle}"`, "missing_key")];
    }
    return typesize < 1
      ? [issue(["typesize"], `expected a positive integer, got ${typesize}`, "invalid_value")]
      : [];
  },
};
