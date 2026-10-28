/** The core `default` chunk key encoding. */
import { configured, type ChunkKeyEncodingDefinition } from "../definition.js";
import { oneOf, optional } from "../typed.js";

/** Configuration of the `default` chunk key encoding; `separator` defaults to `"/"`. */
export interface DefaultChunkKeyEncodingConfiguration {
  separator?: "/" | ".";
}

export const defaultEncoding: ChunkKeyEncodingDefinition<DefaultChunkKeyEncodingConfiguration> = {
  name: "default",
  ...configured({ separator: optional(oneOf(["/", "."])) }),
};
