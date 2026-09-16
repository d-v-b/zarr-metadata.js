/**
 * The data types this package interprets, one module per type, assembled
 * into the dispatch the semantic layer uses: the core scalars, the r<N>
 * raw-bits family, and the established zarr-extensions conventions
 * (string, bytes, numpy.datetime64/timedelta64, struct). Unrecognized
 * names yield no verdicts — the name space is open — and other types'
 * required fields remain registry-schema facts.
 */
import type { PathedIssue } from "../errors.js";
import { configurationMissing, fieldParts } from "../guards.js";
import { bool } from "./bool.js";
import { bytes } from "./bytes.js";
import { complex64 } from "./complex64.js";
import { complex128 } from "./complex128.js";
import {
  issue,
  type ConfigContext,
  type DataTypeDescriptor,
  type FillContext,
} from "./descriptor.js";
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

export type {
  ComplexFillValue,
  ConfigContext,
  DataTypeDescriptor,
  FillContext,
  FloatFillValue,
} from "./descriptor.js";
export type { BytesFillValue } from "./bytes.js";
export type {
  NumpyDatetime64Configuration,
  NumpyDatetime64FillValue,
  NumpyTimeUnit,
} from "./numpy-datetime64.js";
export type { RawBytesFillValue } from "./raw.js";
export type { StringFillValue } from "./string.js";
export type { StructConfiguration, StructField } from "./struct.js";
export type { NumpyTypestr } from "./numpy-typestr.js";

const DESCRIPTORS: readonly DataTypeDescriptor[] = [
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

function descriptorFor(name: string): DataTypeDescriptor | undefined {
  return DESCRIPTORS.find((descriptor) => descriptor.matches(name));
}

// struct fields may nest structs; matches the structural layer's cap.
const MAX_FILL_DEPTH = 64;

function configIssuesFor(dataTypeField: unknown, depth: number): PathedIssue[] {
  if (depth >= MAX_FILL_DEPTH) return [];
  const parts = fieldParts(dataTypeField);
  if (parts === undefined || parts.configuration === undefined) return [];
  const descriptor = descriptorFor(parts.name);
  if (descriptor?.configIssues === undefined) return [];
  const context: ConfigContext = { depth, configIssuesFor };
  return descriptor
    .configIssues(parts.configuration, parts.name, context)
    .map((inner) => ({ ...inner, path: ["configuration", ...inner.path] }));
}

function fillIssuesFor(dataTypeField: unknown, fill: unknown, depth: number): PathedIssue[] {
  if (depth >= MAX_FILL_DEPTH) return [];
  const parts = fieldParts(dataTypeField);
  if (parts === undefined) return [];
  const descriptor = descriptorFor(parts.name);
  if (descriptor === undefined) return []; // unrecognized: no verdict
  const context: FillContext = { configuration: parts.configuration, depth, fillIssuesFor };
  return descriptor.fillIssues(fill, parts.name, context);
}

/**
 * Interpret a document's `data_type` field against its `fill_value`:
 * name-level rules, required configuration members, configuration prose
 * rules, and the fill's JSON shape (recursively, for struct). Issues are
 * pathed from the document root (`data_type` / `fill_value`).
 */
export function dataTypeVerdict(
  rawField: unknown,
  fillPresent: boolean,
  fill: unknown,
): PathedIssue[] {
  const parts = fieldParts(rawField);
  if (parts === undefined) return [];
  const descriptor = descriptorFor(parts.name);
  if (descriptor === undefined) return [];
  const issues: PathedIssue[] = [];
  const nameProblem = descriptor.nameIssue?.(parts.name);
  if (nameProblem !== undefined) {
    issues.push(issue(["data_type"], nameProblem));
  }
  const required = descriptor.requiredConfigKeys;
  if (required !== undefined) {
    if (configurationMissing(rawField)) {
      issues.push(
        issue(
          ["data_type"],
          `${JSON.stringify(parts.name)} requires a configuration with ${required
            .map((key) => JSON.stringify(key))
            .join(" and ")}`,
          "missing_key",
        ),
      );
    } else if (parts.configuration !== undefined) {
      for (const key of required) {
        if (!Object.hasOwn(parts.configuration, key)) {
          issues.push(
            issue(["data_type", "configuration", key], "missing required key", "missing_key"),
          );
        }
      }
    }
  }
  issues.push(
    ...configIssuesFor(rawField, 0).map((inner) => ({ ...inner, path: ["data_type", ...inner.path] })),
  );
  if (fillPresent) {
    issues.push(
      ...fillIssuesFor(rawField, fill, 0).map((inner) => ({
        ...inner,
        path: ["fill_value", ...inner.path],
      })),
    );
  }
  return issues;
}
