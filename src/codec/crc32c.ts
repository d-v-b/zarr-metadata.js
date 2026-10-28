/** The core `crc32c` codec: a checksum with nothing to configure. */
import { configured, type CodecDefinition } from "../definition.js";

export const crc32c: CodecDefinition<Record<string, never>> = {
  name: "crc32c",
  ...configured({}),
  kind: "bytes_bytes",
  // It appends four bytes, so the size of its output is known.
  size: "static",
};
