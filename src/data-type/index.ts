/**
 * The data types this package interprets, one module per type: the core
 * scalars, the r<N> raw-bits family, and the zarr-extensions conventions
 * (string, bytes, numpy.datetime64/timedelta64, struct) — the data types
 * of the reference implementation's `CORE_AND_EXTENSIONS` scope.
 * Unrecognized names are left unjudged; the name space is open.
 */
import type { DataTypeDefinition } from "../definition.js";
import { bool } from "./bool.js";
import { bytes } from "./bytes.js";
import { complex64 } from "./complex64.js";
import { complex128 } from "./complex128.js";
import { float16 } from "./float16.js";
import { float32 } from "./float32.js";
import { float64 } from "./float64.js";
import { int8 } from "./int8.js";
import { int16 } from "./int16.js";
import { int32 } from "./int32.js";
import { int64 } from "./int64.js";
import { numpyDatetime64 } from "./numpy-datetime64.js";
import { numpyTimedelta64 } from "./numpy-timedelta64.js";
import { raw } from "./raw.js";
import { string } from "./string.js";
import { struct } from "./struct.js";
import { uint8 } from "./uint8.js";
import { uint16 } from "./uint16.js";
import { uint32 } from "./uint32.js";
import { uint64 } from "./uint64.js";

export type { BytesFillValue } from "./bytes.js";
export type {
  NumpyDatetime64Configuration,
  NumpyDatetime64FillValue,
  NumpyTimeUnit,
} from "./numpy-datetime64.js";
export type { RawBytesFillValue } from "./raw.js";
export type { ComplexFillValue, FloatFillValue } from "./scalar.js";
export type { StringFillValue } from "./string.js";
export type { StructConfiguration, StructField } from "./struct.js";

export const DATA_TYPES: readonly DataTypeDefinition[] = [
  bool,
  int8, int16, int32, int64,
  uint8, uint16, uint32, uint64,
  float16, float32, float64,
  complex64, complex128,
  raw,
  string, bytes,
  numpyDatetime64, numpyTimedelta64,
  struct,
];
