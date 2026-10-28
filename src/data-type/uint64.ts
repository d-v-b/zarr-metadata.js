import { intDataType, multiByte } from "./scalar.js";

/** The core `uint64` data type: its fill value is an integer in its range. */
export const uint64 = intDataType("uint64", 0, 2 ** 64 - 1, multiByte);
