import { intDataType, singleByte } from "./scalar.js";

/** The core `uint8` data type: its fill value is an integer in its range. */
export const uint8 = intDataType("uint8", 0, 255, singleByte);
