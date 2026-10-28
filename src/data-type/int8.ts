import { intDataType, singleByte } from "./scalar.js";

/** The core `int8` data type: its fill value is an integer in its range. */
export const int8 = intDataType("int8", -128, 127, singleByte);
