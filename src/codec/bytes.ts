/** The core `bytes` codec. */
import { configured, storageOf, type CodecDefinition } from "../definition.js";
import { issue, oneOf, optional, show } from "../typed.js";

/** Configuration of the core `bytes` codec. */
export interface BytesCodecConfiguration {
  endian?: "little" | "big";
}

/**
 * It "encodes arrays of fixed-size numeric data types", so a data type
 * whose values vary in size needs its own codec, and `endian` is "Required
 * for data types for which endianness is applicable": every type whose
 * values take several bytes.
 */
export const bytes: CodecDefinition<BytesCodecConfiguration> = {
  name: "bytes",
  ...configured({ endian: optional(oneOf(["little", "big"])) }),
  kind: "array_bytes",
  size: "static",
  chunkRules: (configuration, _nested, chunk) => {
    const storage = storageOf(chunk.dataType);
    const written = chunk.dataType?.name;
    if (storage === "multi_byte" && !Object.hasOwn(configuration, "endian")) {
      return [
        issue(["endian"], `expected an endian, since each ${show(written)} value takes several bytes`, "missing_key"),
      ];
    }
    if (storage === "variable_length") {
      return [
        issue(
          [],
          `expected a data type of fixed size, got ${show(written)}, whose values vary in size`,
          "invalid_value",
        ),
      ];
    }
    return [];
  },
};
