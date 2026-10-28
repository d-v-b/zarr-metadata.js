import { intDataType, multiByte } from "./scalar.js";

/** The core `int32` data type: its fill value is an integer in its range. */
export const int32 = intDataType("int32", -2147483648, 2147483647, multiByte);
