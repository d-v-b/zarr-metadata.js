import { named, simple, type DataTypeDescriptor } from "./descriptor.js";

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
 * Fill value of the numpy temporal data types: an integer count of
 * `unit * scale_factor` since the epoch, or the `"NaT"` sentinel.
 */
export type NumpyDatetime64FillValue = number | bigint | "NaT";

/** Descriptor factory shared by numpy.datetime64 and numpy.timedelta64. */
export function numpyTemporalDataType(name: string): DataTypeDescriptor {
  return {
    matches: named(name),
    requiredConfigKeys: ["unit", "scale_factor"],
    fillIssues: (fill) =>
      Number.isInteger(fill) || typeof fill === "bigint" || fill === "NaT"
        ? []
        : simple(`expected an integer or "NaT" for data type ${JSON.stringify(name)}`),
  };
}

/** The zarr-extensions `numpy.datetime64` data type. */
export const numpyDatetime64 = numpyTemporalDataType("numpy.datetime64");
