/** The data type families the arithmetic codecs (`cast_value`, `scale_offset`) reason about. */
import { RAW_BITS_NAME } from "../definition.js";

/** Floating-point data types, which are not integral, so `cast_value` may not wrap to them. */
export const FLOATING_POINT: ReadonlySet<string> = new Set([
  "float4_e2m1fn", "float6_e2m3fn", "float6_e3m2fn", "float8_e3m4", "float8_e4m3",
  "float8_e4m3b11fnuz", "float8_e4m3fnuz", "float8_e5m2", "float8_e5m2fnuz", "float8_e8m0fnu",
  "bfloat16", "float16", "float32", "float64",
]);

/** Data types whose values are not numbers (truth values, raw bits, text, byte strings, records). */
export const NOT_NUMBERS: ReadonlySet<string> = new Set(["bool", RAW_BITS_NAME, "string", "bytes", "struct"]);

/** Complex data types: arithmetic is defined, but they do not model real numbers. */
export const COMPLEX: ReadonlySet<string> = new Set(["complex64", "complex128"]);
