import { intDataType, multiByte } from "./scalar.js";

/** The core `uint16` data type: its fill value is an integer in its range. */
export const uint16 = intDataType("uint16", 0, 65535, multiByte);
