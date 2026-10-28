import type { DataTypeDefinition } from "../definition.js";
import { anyOf, integerIn, issue, sequenceOf, show, string } from "../typed.js";
import { NOTHING_TO_CONFIGURE, variableLength } from "./scalar.js";

/**
 * Fill value of the `bytes` data type: an array of integers in `[0, 255]`
 * (one per byte) or a standard-alphabet base64 string.
 */
export type BytesFillValue = number[] | string;

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** Whether `value` is standard-alphabet base64 (padded length a multiple of 4). */
export function isBase64(value: string): boolean {
  return value.length % 4 === 0 && BASE64.test(value);
}

/** One byte of a fill value: an integer in `[0, 255]`. */
export const BYTE = integerIn({ ge: 0, le: 255 });

/** The zarr-extensions `bytes` data type: variable-length byte strings. */
export const bytes: DataTypeDefinition<Record<string, never>, BytesFillValue> = {
  name: "bytes",
  ...NOTHING_TO_CONFIGURE,
  fillValue: anyOf(
    [
      { shape: "tuple", parse: sequenceOf(BYTE) },
      { shape: "str", parse: string },
    ],
    "an array of integers or a string",
  ),
  fillValueRules: (_configuration, _nested, value) =>
    typeof value === "string" && !isBase64(value)
      ? [issue([], `expected standard-alphabet base64, got ${show(value)}`, "invalid_value")]
      : [],
  storage: variableLength,
};
