/**
 * zarr-metadata: spec-defined metadata types and validators for Zarr v2 and
 * v3, in TypeScript.
 *
 * A port of the Python `zarr-metadata` package (the reference
 * implementation), kept in lockstep by a shared conformance corpus.
 */

export type { JSONValue, ZarrV3MetadataFieldJSON, ZarrV3NamedConfigJSON } from "./common.js";
export {
  flattenTree,
  formatTree,
  isEmptyTree,
  MetadataValidationError,
  treeOf,
  type ErrorTree,
  type Issue,
  type IssueKind,
  type IssuePath,
  type ParseResult,
  type PathedIssue,
} from "./errors.js";
export type {
  ChunkGridVerdict,
  RectilinearChunkGridConfiguration,
  RectilinearDimSpec,
  RegularChunkGridConfiguration,
} from "./chunk-grid/index.js";
export type {
  ShardingIndexedCodecConfiguration,
  TransposeCodecConfiguration,
} from "./codec/index.js";
export type {
  BytesFillValue,
  ComplexFillValue,
  FloatFillValue,
  NumpyDatetime64Configuration,
  NumpyDatetime64FillValue,
  NumpyTimeUnit,
  NumpyTypestr,
  RawBytesFillValue,
  StringFillValue,
  StructConfiguration,
  StructField,
} from "./data-type/index.js";
export * from "./schemas.js";
export * from "./semantics.js";
export type { StandardSchemaV1 } from "./standard-schema.js";
export * from "./v2.js";
export * from "./v3.js";
export * from "./validation.js";
