import { intDataType, multiByte } from "./scalar.js";

/** The core `int16` data type: its fill value is an integer in its range. */
export const int16 = intDataType("int16", -32768, 32767, multiByte);
