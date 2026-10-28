import type { DataTypeDefinition } from "../definition.js";
import { string as jsonString } from "../typed.js";
import { NOTHING_TO_CONFIGURE, variableLength } from "./scalar.js";

/** Fill value of the `string` data type: a JSON unicode string. */
export type StringFillValue = string;

/** The zarr-extensions `string` data type: variable-length UTF-8, each value stored in as many bytes as it needs. */
export const string: DataTypeDefinition = {
  name: "string",
  ...NOTHING_TO_CONFIGURE,
  fillValue: jsonString,
  storage: variableLength,
};
