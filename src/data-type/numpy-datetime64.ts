import { isIntegerInRange, named, simple, type DataTypeDescriptor } from "./descriptor.js";

/** Time unit codes used by numpy.datetime64 / numpy.timedelta64. */
export type NumpyTimeUnit =
  | "Y" | "M" | "W" | "D" | "h" | "m" | "s"
  | "ms" | "us" | "μs" | "ns" | "ps" | "fs" | "as" | "generic";

/** Configuration of the numpy temporal data types. */
export interface NumpyDatetime64Configuration {
  unit: NumpyTimeUnit;
  scale_factor: number;
}

/**
 * Fill value of the numpy temporal data types: an int64 count of
 * `unit * scale_factor` since the epoch, or the `"NaT"` sentinel.
 */
export type NumpyDatetime64FillValue = number | bigint | "NaT";

/** Descriptor factory shared by numpy.datetime64 and numpy.timedelta64. */
export function numpyTemporalDataType(name: string): DataTypeDescriptor {
  return {
    matches: named(name),
    requiredConfigKeys: ["unit", "scale_factor"],
    // "a JSON number with no fraction or exponent part that is within the
    // range [-2^63, 2^63 - 1]", or "NaT" (which -2^63 also spells).
    fillIssues: (fill) =>
      isIntegerInRange(fill, -9223372036854775808n, 9223372036854775807n) || fill === "NaT"
        ? []
        : simple(
            `expected an integer in [-9223372036854775808, 9223372036854775807] or "NaT" for data type ${JSON.stringify(name)}`,
          ),
  };
}

/** The zarr-extensions `numpy.datetime64` data type. */
export const numpyDatetime64 = numpyTemporalDataType("numpy.datetime64");
