/** The zarr-extensions `zstd` codec. */
import { configured, type CodecDefinition } from "../definition.js";
import { boolean, integerIn, optional, required } from "../typed.js";

/** Configuration of the zarr-extensions `zstd` codec. */
export interface ZstdCodecConfiguration {
  /** ZSTD_minCLevel() (-131072) through ZSTD_maxCLevel() (22). */
  level: number;
  checksum?: boolean;
}

export const zstd: CodecDefinition<ZstdCodecConfiguration> = {
  name: "zstd",
  ...configured({
    level: required(integerIn({ ge: -131072, le: 22 })),
    checksum: optional(boolean),
  }),
  kind: "bytes_bytes",
  size: "dynamic",
};
