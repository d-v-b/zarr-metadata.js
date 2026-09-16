/**
 * Zarr v2 metadata document types.
 *
 * See https://zarr-specs.readthedocs.io/en/latest/v2/v2.0.html
 */

import type { JSONValue } from "./common.js";
import { exactKeys, type OptionalKeysOf, type RequiredKeysOf } from "./keys.js";

/**
 * The v2 dtype representation.
 *
 * Either a numpy-style dtype string (e.g. `"<f8"`, `"|S10"`) or an array of
 * field records describing a structured dtype. Each field record is either a
 * 2-tuple `[name, datatype]` or a 3-tuple `[name, datatype, shape]` (the
 * 3-tuple form indicates a subarray field). A field datatype may itself be
 * another structured dtype.
 *
 * See https://zarr-specs.readthedocs.io/en/latest/v2/v2.0.html#data-type-encoding
 */
export type ZarrV2DataTypeMetadata =
  | string
  | Array<[string, ZarrV2DataTypeMetadata] | [string, ZarrV2DataTypeMetadata, number[]]>;

/** `"C"` (row-major) or `"F"` (column-major) — the in-chunk byte layout. */
export const ZARR_V2_ARRAY_ORDER = ["C", "F"] as const;
export type ZarrV2ArrayOrder = (typeof ZARR_V2_ARRAY_ORDER)[number];

/** `"."` (legacy default) or `"/"` (nested directories). */
export const ZARR_V2_ARRAY_DIMENSION_SEPARATOR = [".", "/"] as const;
export type ZarrV2ArrayDimensionSeparator = (typeof ZARR_V2_ARRAY_DIMENSION_SEPARATOR)[number];

/**
 * A numcodecs configuration object, used as a v2 compressor or filter.
 *
 * The required `id` field names the codec; codec-specific parameters
 * (e.g. `cname`, `clevel` for blosc) appear as extra fields.
 */
export type ZarrV2CodecMetadata = { id: string } & { [key: string]: JSONValue };

/**
 * On-disk `.zarray` file content.
 *
 * User attributes live in a sibling `.zattrs` file and are NOT part of this
 * type; see `ZarrV2ZAttrsJSON`.
 */
export type ZarrV2ZArrayJSON = {
  zarr_format: 2;
  shape: number[];
  chunks: number[];
  dtype: ZarrV2DataTypeMetadata;
  compressor: ZarrV2CodecMetadata | null;
  fill_value: JSONValue;
  order: ZarrV2ArrayOrder;
  filters: ZarrV2CodecMetadata[] | null;
  dimension_separator?: ZarrV2ArrayDimensionSeparator;
};

/**
 * Zarr v2 array metadata document, in-memory merged form: the `.zarray`
 * fields plus the sibling `.zattrs` attributes folded in as `attributes`.
 */
export type ZarrV2ArrayMetadataJSON = ZarrV2ZArrayJSON & {
  attributes?: { [key: string]: JSONValue };
};

/**
 * On-disk `.zgroup` file content. The spec defines exactly one field and
 * forbids others.
 *   https://github.com/zarr-developers/zarr-specs/blob/fc7dd9c9beb5a50b87f9b08b00bf50fc0048482f/docs/v2/v2.0.rst#L306-L313
 */
export type ZarrV2ZGroupJSON = {
  zarr_format: 2;
};

/**
 * Zarr v2 group metadata document, in-memory merged form: the `.zgroup`
 * field plus the sibling `.zattrs` attributes folded in as `attributes`.
 */
export type ZarrV2GroupMetadataJSON = ZarrV2ZGroupJSON & {
  attributes?: { [key: string]: JSONValue };
};

/** On-disk `.zattrs` file content: a JSON object of user attributes. */
export type ZarrV2ZAttrsJSON = { [key: string]: JSONValue };

/**
 * `.zmetadata` file contents (v2 consolidated metadata).
 *
 * NOT a spec artifact: a reference-implementation convention. The `metadata`
 * map uses flat path keys (`"foo/bar/.zarray"`, `"foo/.zattrs"`, ...)
 * pointing to the JSON contents of the file at that path.
 */
export type ZarrV2ConsolidatedMetadataJSON = {
  zarr_consolidated_format: 1;
  metadata: { [key: string]: JSONValue };
};

export const ZARR_V2_ARRAY_METADATA_STORE_KEY = ".zarray";
export const ZARR_V2_GROUP_METADATA_STORE_KEY = ".zgroup";
export const ZARR_V2_ATTRIBUTES_STORE_KEY = ".zattrs";
export const ZARR_V2_CONSOLIDATED_METADATA_STORE_KEY = ".zmetadata";

/** The standard top-level keys of a merged v2 array metadata document. */
export const ARRAY_METADATA_REQUIRED_KEYS_V2 = exactKeys<RequiredKeysOf<ZarrV2ArrayMetadataJSON>>()([
  "zarr_format",
  "shape",
  "chunks",
  "dtype",
  "compressor",
  "fill_value",
  "order",
  "filters",
]);
export const ARRAY_METADATA_OPTIONAL_KEYS_V2 = exactKeys<OptionalKeysOf<ZarrV2ArrayMetadataJSON>>()([
  "dimension_separator",
  "attributes",
]);
export const ARRAY_METADATA_STANDARD_KEYS_V2 = [
  ...ARRAY_METADATA_REQUIRED_KEYS_V2,
  ...ARRAY_METADATA_OPTIONAL_KEYS_V2,
] as const;

/** The standard top-level keys of a merged v2 group metadata document. */
export const GROUP_METADATA_REQUIRED_KEYS_V2 = exactKeys<RequiredKeysOf<ZarrV2GroupMetadataJSON>>()(["zarr_format"]);
export const GROUP_METADATA_OPTIONAL_KEYS_V2 = exactKeys<OptionalKeysOf<ZarrV2GroupMetadataJSON>>()(["attributes"]);
export const GROUP_METADATA_STANDARD_KEYS_V2 = [
  ...GROUP_METADATA_REQUIRED_KEYS_V2,
  ...GROUP_METADATA_OPTIONAL_KEYS_V2,
] as const;
