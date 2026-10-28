---
"zarr-metadata": minor
---

The semantic layer (`validateArraySemanticsV3`, `validateSemanticsV3`) now applies the rules zarr-metadata 0.6.0 applies in its default scope, and the conformance corpus checks it against that release. Together with the structural validators it reports what the Python readers report.

- Every codec, chunk grid, chunk key encoding and data type the reference defines is read through its definition: `blosc`, `bytes`, `cast_value`, `crc32c`, `gzip`, `scale_offset`, `sharding_indexed`, `transpose` and `zstd`; `regular` and `rectilinear`; `default` and `v2`; and every core and convention data type. A configuration value out of range, of the wrong type, or outside its closed set is a problem, and so is a key the configuration does not declare (`unknown_key`). A missing configuration is reported at `<field>.configuration`.
- The codecs are read as a pipeline: array -> array codecs, one array -> bytes codec, then bytes -> bytes codecs, each judged against the chunk it receives. A `bytes` codec needs an `endian` for values of several bytes and refuses variable-length values; a shard's index codecs must be of static size and receive `uint64` values; a shard's inner chunk length is reported per axis.
- Fill values report `invalid_type` for the wrong JSON type and `invalid_value` for a value out of range. A struct needs at least one field, distinct non-empty names, and fixed-size field types.
- Fixed: a rectilinear grid's chunk lengths may exceed the dimension's length, as the spec allows ("MUST equal or exceed"); they were required to sum to it exactly. Fixed: no rule reads a `shape` that has its own problem.
