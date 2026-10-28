import { complexDataType } from "./scalar.js";

/** The core `complex64` data type: its fill value is a pair of `float32` fill values. */
export const complex64 = complexDataType("complex64", "float32", 8);
