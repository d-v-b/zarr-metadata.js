import type { DataTypeDefinition } from "../definition.js";
import { boolean } from "../typed.js";
import { NOTHING_TO_CONFIGURE, singleByte } from "./scalar.js";

/** The core `bool` data type: its fill value is a boolean. */
export const bool: DataTypeDefinition = {
  name: "bool",
  ...NOTHING_TO_CONFIGURE,
  fillValue: boolean,
  storage: singleByte,
};
