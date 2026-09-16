/**
 * The v2 `dtype` encoding — the NumPy array-protocol typestr the spec
 * adopts for simple data types, and the `[name, typestr, shape?]` record
 * lists for structured ones — plus the spec's fill-value encodings per
 * type. Structure (string or list) is the corpus-governed structural
 * layer's business; this module interprets the contents.
 *   https://github.com/zarr-developers/zarr-specs/blob/fc7dd9c9beb5a50b87f9b08b00bf50fc0048482f/docs/v2/v2.0.rst#L130-L148 (typestr)
 *   https://github.com/zarr-developers/zarr-specs/blob/fc7dd9c9beb5a50b87f9b08b00bf50fc0048482f/docs/v2/v2.0.rst#L152-L176 (structured)
 *   https://github.com/zarr-developers/zarr-specs/blob/fc7dd9c9beb5a50b87f9b08b00bf50fc0048482f/docs/v2/v2.0.rst#L178-L194 (fill values)
 */
import type { PathedIssue } from "../errors.js";
import { isPlainObject } from "../guards.js";
import { isBase64 } from "./bytes.js";
import { isIntegerInRange, issue } from "./descriptor.js";

/** A parsed simple v2 data type. */
export interface NumpyTypestr {
  /** `"<"` little-endian, `">"` big-endian, `"|"` not relevant. */
  byteorder: "<" | ">" | "|";
  /** NumPy kind code: b i u f c m M S U V. */
  code: "b" | "i" | "u" | "f" | "c" | "m" | "M" | "S" | "U" | "V";
  /** Item size in bytes. */
  size: number;
  /** Datetime/timedelta unit (with optional multiplier), e.g. `"ns"`, `"10s"`. */
  unit?: string;
}

// Byte order, kind code, byte count, and an optional NumPy datetime unit
// (which may carry a multiplier, as in "[10s]").
const TYPESTR = /^([<>|])([biufcmMSUV])(\d+)(?:\[((?:\d+)?(?:Y|M|W|D|h|m|s|ms|us|μs|ns|ps|fs|as))\])?$/u;

/** The item sizes NumPy defines for the fixed-size kinds. */
const SIZES: Partial<Record<NumpyTypestr["code"], readonly number[]>> = {
  b: [1],
  i: [1, 2, 4, 8],
  u: [1, 2, 4, 8],
  f: [2, 4, 8, 16],
  c: [8, 16, 32],
  m: [8],
  M: [8],
};

/**
 * Parse a typestr, or explain why it is not one. The grammar is the spec's
 * three parts; "The byte order MUST be specified"; datetime/timedelta types
 * "MUST also include the units"; item sizes are NumPy's, to which the spec
 * defers.
 *   https://github.com/zarr-developers/zarr-specs/blob/fc7dd9c9beb5a50b87f9b08b00bf50fc0048482f/docs/v2/v2.0.rst#L132-L142
 *   https://github.com/zarr-developers/zarr-specs/blob/fc7dd9c9beb5a50b87f9b08b00bf50fc0048482f/docs/v2/v2.0.rst#L144
 *   https://github.com/zarr-developers/zarr-specs/blob/fc7dd9c9beb5a50b87f9b08b00bf50fc0048482f/docs/v2/v2.0.rst#L147-L148
 */
export function parseNumpyTypestr(
  text: string,
): { typestr: NumpyTypestr; problem?: undefined } | { typestr?: undefined; problem: string } {
  const match = TYPESTR.exec(text);
  const shown = JSON.stringify(text);
  if (match === null) {
    if (/^[biufcmMSUV]\d+/.test(text)) {
      return { problem: `the byte order ("<", ">", or "|") must be specified, got ${shown}` };
    }
    return {
      problem: `expected a NumPy typestr (byte order, type code, byte count, e.g. "<f8"), got ${shown}`,
    };
  }
  const typestr: NumpyTypestr = {
    byteorder: match[1] as NumpyTypestr["byteorder"],
    code: match[2] as NumpyTypestr["code"],
    size: Number(match[3]),
  };
  if (match[4] !== undefined) typestr.unit = match[4];
  const sizes = SIZES[typestr.code];
  if (sizes !== undefined && !sizes.includes(typestr.size)) {
    return {
      problem: `no ${JSON.stringify(typestr.code)} type is ${typestr.size} bytes wide (expected ${sizes.join(", ")}), got ${shown}`,
    };
  }
  const temporal = typestr.code === "m" || typestr.code === "M";
  if (temporal && typestr.unit === undefined) {
    return {
      problem: `datetime ("M") and timedelta ("m") types must include units in square brackets, e.g. "<M8[ns]", got ${shown}`,
    };
  }
  if (!temporal && typestr.unit !== undefined) {
    return {
      problem: `units apply only to datetime ("M") and timedelta ("m") types, got ${shown}`,
    };
  }
  return { typestr };
}

// Structured records may nest; matches the structural layer's depth cap.
const MAX_DTYPE_DEPTH = 64;

/**
 * Problems with a v2 `dtype` value's contents, pathed relative to it: an
 * ill-formed typestr, or in a structured list a duplicate field name, a
 * negative subarray dimension, or any of these in a field's own type.
 * Values of the wrong shape (not a string or list, malformed records) are
 * the structural layer's problem and yield nothing here.
 *   https://github.com/zarr-developers/zarr-specs/blob/fc7dd9c9beb5a50b87f9b08b00bf50fc0048482f/docs/v2/v2.0.rst#L152-L156
 */
export function dtypeIssuesV2(dtype: unknown, depth = 0): PathedIssue[] {
  if (depth >= MAX_DTYPE_DEPTH) return [];
  if (typeof dtype === "string") {
    const { problem } = parseNumpyTypestr(dtype);
    return problem === undefined ? [] : [issue([], problem)];
  }
  if (!Array.isArray(dtype)) return [];
  const issues: PathedIssue[] = [];
  const names = new Set<string>();
  dtype.forEach((record, index) => {
    if (!Array.isArray(record)) return;
    const [name, fieldType, shape] = record as unknown[];
    if (typeof name === "string") {
      if (names.has(name)) {
        issues.push(issue([index, 0], `duplicate field name ${JSON.stringify(name)}`));
      }
      names.add(name);
    }
    issues.push(
      ...dtypeIssuesV2(fieldType, depth + 1).map((inner) => ({
        ...inner,
        path: [index, 1, ...inner.path],
      })),
    );
    if (Array.isArray(shape) && shape.some((dim) => Number.isInteger(dim) && (dim as number) < 0)) {
      issues.push(issue([index, 2], "expected non-negative integers"));
    }
  });
  return issues;
}

const FLOAT_SENTINELS = new Set(["NaN", "Infinity", "-Infinity"]);

/**
 * A float fill: a JSON number or one of the spec's three sentinels.
 *   https://github.com/zarr-developers/zarr-specs/blob/fc7dd9c9beb5a50b87f9b08b00bf50fc0048482f/docs/v2/v2.0.rst#L181-L189
 */
function isFloatFillV2(value: unknown): boolean {
  return (
    typeof value === "number" ||
    typeof value === "bigint" ||
    (typeof value === "string" && FLOAT_SENTINELS.has(value))
  );
}

const FLOAT_FORMS = 'a number, "NaN", "Infinity", or "-Infinity"';

/**
 * Problems with a v2 `fill_value` judged against its `dtype`, pathed
 * relative to the fill: "A scalar value ... or null", the float sentinels,
 * and base64 for byte strings and structured types. `null` is always
 * permitted. A `dtype` this module cannot interpret (ill-formed, or not a
 * string or list) yields nothing — its own issue covers the document.
 *   https://github.com/zarr-developers/zarr-specs/blob/fc7dd9c9beb5a50b87f9b08b00bf50fc0048482f/docs/v2/v2.0.rst#L70-L71
 *   https://github.com/zarr-developers/zarr-specs/blob/fc7dd9c9beb5a50b87f9b08b00bf50fc0048482f/docs/v2/v2.0.rst#L181-L189
 *   https://github.com/zarr-developers/zarr-specs/blob/fc7dd9c9beb5a50b87f9b08b00bf50fc0048482f/docs/v2/v2.0.rst#L191-L194
 */
export function fillIssuesV2(dtype: unknown, fill: unknown): PathedIssue[] {
  if (fill === null) return [];
  if (Array.isArray(dtype)) {
    // "If an array has ... a structured data type, and if the fill value is
    // not null, then the fill value MUST be encoded as an ASCII string using
    // the standard Base64 alphabet."
    //   https://github.com/zarr-developers/zarr-specs/blob/fc7dd9c9beb5a50b87f9b08b00bf50fc0048482f/docs/v2/v2.0.rst#L191-L194
    return typeof fill === "string" && isBase64(fill)
      ? []
      : [issue([], "expected a base64 string fill value for a structured dtype")];
  }
  if (typeof dtype !== "string") return [];
  const { typestr } = parseNumpyTypestr(dtype);
  if (typestr === undefined) return [];
  const shown = JSON.stringify(dtype);
  const bits = BigInt(typestr.size) * 8n;
  switch (typestr.code) {
    case "f":
      return isFloatFillV2(fill)
        ? []
        : [issue([], `expected ${FLOAT_FORMS} for dtype ${shown}`)];
    case "c": {
      const ok =
        isFloatFillV2(fill) ||
        (Array.isArray(fill) && fill.length === 2 && fill.every(isFloatFillV2));
      return ok
        ? []
        : [
            issue(
              [],
              `expected ${FLOAT_FORMS}, or a two-element [real, imaginary] array of those, for dtype ${shown}`,
            ),
          ];
    }
    case "i":
    case "u": {
      const low = typestr.code === "i" ? -(2n ** (bits - 1n)) : 0n;
      const high = typestr.code === "i" ? 2n ** (bits - 1n) - 1n : 2n ** bits - 1n;
      return isIntegerInRange(fill, low, high)
        ? []
        : [issue([], `expected an integer in [${low}, ${high}] for dtype ${shown}`)];
    }
    case "S":
    case "V":
      // "If an array has a fixed length byte string data type (e.g.,
      // "|S12") ... the fill value MUST be encoded as an ASCII string using
      // the standard Base64 alphabet."
      //   https://github.com/zarr-developers/zarr-specs/blob/fc7dd9c9beb5a50b87f9b08b00bf50fc0048482f/docs/v2/v2.0.rst#L191-L194
      return typeof fill === "string" && isBase64(fill)
        ? []
        : [issue([], `expected a base64 string fill value for dtype ${shown}`)];
    case "m":
    case "M":
      return isIntegerInRange(fill, -(2n ** 63n), 2n ** 63n - 1n) || fill === "NaT"
        ? []
        : [issue([], `expected an int64 integer or "NaT" for dtype ${shown}`)];
    default:
      // b, U: the spec fixes no encoding beyond "a scalar value".
      return isPlainObject(fill) || Array.isArray(fill)
        ? [issue([], `expected a scalar fill value for dtype ${shown}`)]
        : [];
  }
}
