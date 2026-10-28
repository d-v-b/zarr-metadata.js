import { configured, type DataTypeDefinition } from "../definition.js";
import { anyOf, integerIn, oneOf, required } from "../typed.js";
import { multiByte } from "./scalar.js";

/** Time unit codes used by numpy.datetime64 / numpy.timedelta64. */
export type NumpyTimeUnit =
  | "Y" | "M" | "W" | "D" | "h" | "m" | "s"
  | "ms" | "us" | "μs" | "ns" | "ps" | "fs" | "as" | "generic";

const NUMPY_TIME_UNITS: readonly NumpyTimeUnit[] = [
  "Y", "M", "W", "D", "h", "m", "s", "ms", "us", "μs", "ns", "ps", "fs", "as", "generic",
];

/** Configuration of the numpy temporal data types. */
export interface NumpyDatetime64Configuration {
  unit: NumpyTimeUnit;
  /** The number of units in one tick: a positive int32. */
  scale_factor: number;
}

/**
 * Fill value of the numpy temporal data types: a signed 64-bit count of
 * `unit * scale_factor` since the epoch, or the `"NaT"` sentinel.
 */
export type NumpyDatetime64FillValue = number | "NaT";

/**
 * Definition factory shared by numpy.datetime64 and numpy.timedelta64. Both
 * are stored as signed 64-bit integers, in the byte order the codecs say.
 */
export function numpyTemporalDataType(name: string): DataTypeDefinition {
  return {
    name,
    ...configured({
      unit: required(oneOf(NUMPY_TIME_UNITS)),
      scale_factor: required(integerIn({ ge: 1, le: 2 ** 31 - 1 })),
    }),
    fillValue: anyOf(
      [
        { shape: "int", parse: integerIn({ ge: -(2 ** 63), le: 2 ** 63 - 1 }) },
        { shape: "str", parse: oneOf(["NaT"]), literal: true },
      ],
      'an integer or "NaT"',
    ),
    storage: multiByte,
  };
}

/** The zarr-extensions `numpy.datetime64` data type. */
export const numpyDatetime64 = numpyTemporalDataType("numpy.datetime64");
