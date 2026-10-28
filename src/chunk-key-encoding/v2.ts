/** The core `v2` chunk key encoding, for converting v2 arrays without renaming chunks. */
import { configured, type ChunkKeyEncodingDefinition } from "../definition.js";
import { oneOf, optional } from "../typed.js";

/** Configuration of the `v2` chunk key encoding; `separator` defaults to `"."`. */
export interface V2ChunkKeyEncodingConfiguration {
  separator?: "/" | ".";
}

export const v2Encoding: ChunkKeyEncodingDefinition<V2ChunkKeyEncodingConfiguration> = {
  name: "v2",
  ...configured({ separator: optional(oneOf(["/", "."])) }),
};
