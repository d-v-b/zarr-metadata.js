import { intDataType, multiByte } from "./scalar.js";

/** The core `uint32` data type: its fill value is an integer in its range. */
export const uint32 = intDataType("uint32", 0, 4294967295, multiByte);
