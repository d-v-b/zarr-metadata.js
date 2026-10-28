# zarr-metadata

## 0.10.0

### Minor Changes

- 6eb15aa: Stores written by zarr-python with a NaN or infinite number in attributes can now be read. zarr-python writes such a value (an xarray `_FillValue` or a CF `missing_value`, for example) as a bare `NaN`, `Infinity` or `-Infinity`, which `loadStoreJson` refused as invalid JSON. It now reads these tokens, and the validators accept non-finite numbers in attributes, in extension fields nothing interprets, and in `.zattrs` entries, as zarr-metadata 0.6.0 does, while still refusing them wherever the spec interprets a value, such as `fill_value`. `dumpStoreJson(value, { allowNonFinite: true })` writes them back as the same tokens.
- 6eb15aa: The semantic layer (`validateArraySemanticsV3`, `validateSemanticsV3`) now applies the rules zarr-metadata 0.6.0 applies in its default scope, and the conformance corpus checks it against that release. Together with the structural validators it reports what the Python readers report.
  
  - Every codec, chunk grid, chunk key encoding and data type the reference defines is read through its definition: `blosc`, `bytes`, `cast_value`, `crc32c`, `gzip`, `scale_offset`, `sharding_indexed`, `transpose` and `zstd`; `regular` and `rectilinear`; `default` and `v2`; and every core and convention data type. A configuration value out of range, of the wrong type, or outside its closed set is a problem, and so is a key the configuration does not declare (`unknown_key`). A missing configuration is reported at `<field>.configuration`.
  - The codecs are read as a pipeline: array -> array codecs, one array -> bytes codec, then bytes -> bytes codecs, each judged against the chunk it receives. A `bytes` codec needs an `endian` for values of several bytes and refuses variable-length values; a shard's index codecs must be of static size and receive `uint64` values; a shard's inner chunk length is reported per axis.
  - Fill values report `invalid_type` for the wrong JSON type and `invalid_value` for a value out of range. A struct needs at least one field, distinct non-empty names, and fixed-size field types.
  - Fixed: a rectilinear grid's chunk lengths may exceed the dimension's length, as the spec allows ("MUST equal or exceed"); they were required to sum to it exactly. Fixed: no rule reads a `shape` that has its own problem.
  - The `ChunkGridVerdict` type is no longer exported: the semantic layer's internal machinery changed, and the configuration types (`RegularChunkGridConfiguration` and the others) remain the public description of what each name takes.
- 6eb15aa: The structural validators now report what zarr-metadata 0.6.0, the Python reference, reports, and the conformance corpus is checked against that release. This changes some verdicts:
  
  - `must_understand: false` is refused on codecs and storage transformers, as on `data_type`, `chunk_grid` and `chunk_key_encoding`: ignoring a codec gives wrong bytes.
  - Every v3 metadata field name must be a valid extension name (`^[a-z][a-z0-9-_.]+$`) or a URI.
  - A key that a closed object does not declare is reported with the new kind `unknown_key` instead of `invalid_value`. A value of the wrong JSON type for a fixed literal (`zarr_format: "3"`) is `invalid_type`. A metadata field object without a `name` is `missing_key`.
  - `consolidated_metadata: null` is refused. `validateGroupMetadataV3` checks only the envelope of `consolidated_metadata`; `validateConsolidatedMetadataV3` reads the listed documents, including the rules that their keys are node paths, that they form a hierarchy, and that a group listed twice reads the same in both listings. `validateMetadataV3` still reads both for a group.
  - A v2 `.zarray` may hold members the spec does not define, `filters: []` is accepted, a v2 dtype string must be a NumPy typestr, a codec id must not be empty, and problems in codec ids and field records are located at the id or record. `validateConsolidatedMetadataV2` now reads each `.zarray` and `.zgroup` entry as a node, so `validateConsolidatedDocumentsV2` is deprecated; neither checks a `.zattrs` entry that has no node beside it.

## 0.9.0

### Minor Changes

- 7fcb238: The semantic layer now interprets the established convention data types
  alongside the core scalars: `string` (string fills), `bytes` (byte arrays
  or base64), `numpy.datetime64`/`numpy.timedelta64` (required
  `unit`/`scale_factor` configuration; integer or `"NaT"` fills), the `r<N>`
  raw-bits family (N must be a positive multiple of 8; fills carry exactly
  N/8 bytes), and `struct` (required `fields` configuration; the fill is an
  object judged per field against each field's own data type, recursively,
  with missing and extraneous fields flagged). The content modules are also
  reorganized one file per interpreted name — `data-type/`, `chunk-grid/`,
  and `codec/` directories mirroring the Python reference's layout — and the
  new configuration/fill types are exported.

## 0.8.0

### Minor Changes

- The semantic layer is reorganized by content rather than by level of
  description: `chunk-grids.ts`, `codecs.ts`, and `data-types.ts` each hold
  the syntax (now-exported configuration types such as
  `RegularChunkGridConfiguration` and `ShardingIndexedCodecConfiguration`)
  and semantics for the names the package interprets, with `semantics.ts`
  reduced to the document-walking orchestrator. Behavior is unchanged (the
  full test suite passes untouched); the structural document layer stays
  content-agnostic and corpus-governed by design.

## 0.7.0

### Minor Changes

- The semantic layer's required-configuration rules now cover every name it
  interprets: `transpose` requires a configuration with `order`, and
  `sharding_indexed` requires one with `chunk_shape`, `codecs`, and
  `index_codecs` (a present inner pipeline is still judged even when
  `chunk_shape` is missing). Names the layer does not interpret (blosc,
  gzip, zstd, extension data types) are deliberately excluded — their
  required fields are registry-schema facts enforced by schema-driven
  tooling, and duplicating them as hardcoded rules would drift.

## 0.6.0

### Minor Changes

- The semantic layer now enforces the configuration requirements the spec
  states for the two known chunk grids: `"regular"` requires a configuration
  with `chunk_shape`, and `"rectilinear"` requires one with `kind` and
  `chunk_shapes`. Previously a configless grid passed every always-on layer
  silently. These are spec-semantics rules (knowing what the names mean),
  so they live in the semantic layer rather than the structural validators,
  whose extension points stay uninterpreted for conformance-corpus parity.
  A present-but-malformed configuration remains the structural layer's
  complaint.

## 0.5.0

### Minor Changes

- Consolidated metadata gets full-depth coverage beyond structure. New
  `validateSemanticsV3` applies the semantic rules to a group's inline
  consolidated entries recursively (nested groups included), pathing issues
  through `consolidated_metadata.metadata.<key>`; `validateArraySemanticsV3`
  is unchanged. New `validateConsolidatedDocumentsV2` interprets `.zmetadata`
  entries by key suffix — `.zarray`/`.zgroup` as on-disk documents (also
  rejecting an `attributes` member, which belongs in the sibling `.zattrs`),
  `.zattrs` as a JSON object — the consumer-side layer the reference model
  deliberately leaves out; `validateConsolidatedMetadataV2` stays
  envelope-only for conformance-corpus parity.

## 0.4.1

### Patch Changes

- `validateArraySemanticsV3` now threads dimensional context through codec
  pipelines instead of assuming it constant (mirroring zarr-python's
  chunk-spec threading, d-v-b/zarr-python#303): a valid `transpose` permutes
  the per-dimension chunk sizes downstream shards must divide, and any codec
  the layer cannot reason about — `reshape` may change a chunk's rank,
  unknown codecs may do anything — invalidates the dimensional context for
  the rest of the pipeline. Fixes false rejections of spec-endorsed
  reshape→transpose chains and of shards sized for the transposed chunk, and
  a missed rejection of shards sized for the un-transposed chunk.

## 0.4.0

### Minor Changes

- `validateArraySemanticsV3` now interprets the `rectilinear` chunk grid:
  `chunk_shapes` must have one entry per dimension of `shape`, explicit chunk
  lists (integers and `[size, count]` run-length pairs) must sum exactly to
  their dimension's length (the bare-integer uniform shorthand carries no sum
  constraint), and a `sharding_indexed` codec's inner chunks must now evenly
  divide every distinct per-dimension chunk size of the grid — uniform or
  rectilinear — rather than only a regular grid's chunk shape.

## 0.3.0

### Minor Changes

- Add `validateArraySemanticsV3`, a semantic (cross-field) layer over the
  structural validators: the regular chunk grid's arity against `shape`,
  `transpose` orders as dimension permutations, `sharding_indexed` inner
  chunk shapes matching dimensionality and evenly dividing the chunk they
  shard (recursively), and `fill_value` fitting the named core data type.
  Unrecognized extension names are skipped. This layer has no Python
  counterpart and is covered by package tests rather than the conformance
  corpus.

## 0.2.0

### Minor Changes

- Add `mustUnderstandExtensionFieldsV3`, reporting the extension-field keys of
  a v3 array or group document that a reader is obligated to understand — every
  unrecognized top-level key not waived with an explicit
  `"must_understand": false` object, per the v3 spec's rule that
  implementations must refuse to open nodes carrying obligated fields they do
  not recognize.
