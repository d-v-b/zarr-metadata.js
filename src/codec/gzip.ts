/** The core `gzip` codec. */
import { configured, type CodecDefinition } from "../definition.js";
import { integerIn, required } from "../typed.js";

/** Configuration of the core `gzip` codec. */
export interface GzipCodecConfiguration {
  /** 0 (no compression) through 9 (best compression). */
  level: number;
}

export const gzip: CodecDefinition<GzipCodecConfiguration> = {
  name: "gzip",
  ...configured({ level: required(integerIn({ ge: 0, le: 9 })) }),
  kind: "bytes_bytes",
  size: "dynamic",
};
