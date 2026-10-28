import { intDataType, multiByte } from "./scalar.js";

/** The core `int64` data type: its fill value is an integer in its range. */
export const int64 = intDataType("int64", -(2 ** 63), 2 ** 63 - 1, multiByte);
