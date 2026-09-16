/**
 * Cross-version primitives for Zarr metadata.
 *
 * This package is a TypeScript port of the Python `zarr-metadata` package
 * (https://pypi.org/project/zarr-metadata/), which is the reference
 * implementation. The two are kept in lockstep by a shared conformance
 * corpus; see `conformance/` at the repository root.
 */

/**
 * A JSON-encodable value. A `bigint` is a JSON integer too large to
 * represent exactly as a `number` (beyond `Number.MAX_SAFE_INTEGER`), as
 * produced by `decodeStoreJson`.
 */
export type JSONValue =
  | string
  | number
  | bigint
  | boolean
  | null
  | JSONValue[]
  | { [key: string]: JSONValue };

/**
 * Externally-tagged union member for a v3 metadata field.
 *
 * The optional `configuration` mapping holds arbitrary JSON-encodable
 * values. `must_understand` is implicitly true when absent.
 */
export type ZarrV3NamedConfigJSON = {
  name: string;
  configuration?: { [key: string]: JSONValue };
  must_understand?: boolean;
};

/**
 * The JSON shape of any v3 metadata extension-point entry: either a bare
 * short-hand name string or a `{name, configuration, must_understand}`
 * envelope.
 *
 * Used for `data_type`, `chunk_grid`, `chunk_key_encoding`, individual
 * codec entries, and `storage_transformers` in v3 array metadata.
 */
export type ZarrV3MetadataFieldJSON = string | ZarrV3NamedConfigJSON;
