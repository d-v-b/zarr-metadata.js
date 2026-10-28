import { complexDataType } from "./scalar.js";

/** The core `complex128` data type: its fill value is a pair of `float64` fill values. */
export const complex128 = complexDataType("complex128", "float64", 16);
