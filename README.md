# zarr-metadata (TypeScript)

Spec-defined metadata types and structural validators for
[Zarr](https://zarr.dev) v2 and v3, in TypeScript. A port of the Python
[`zarr-metadata`](https://pypi.org/project/zarr-metadata/) package (the
reference implementation), kept in lockstep by a shared conformance corpus.

```ts
import {
  validateMetadataV3,
  safeParseArrayMetadataV2,
  isEmptyTree,
  flattenTree,
} from "zarr-metadata";

// Validation produces a tree of errors mirroring the document's shape;
// an empty tree means the document is valid.
const errors = validateMetadataV3(JSON.parse(text));
if (!isEmptyTree(errors)) {
  errors.children.get("codecs"); // the subtree of codec problems
  flattenTree(errors); // the flat view, for diagnostics:
  // [{ path: ["codecs"], kind: "invalid_value", message: "expected an array -> bytes codec, got none" }]
}

// Or the discriminated-union form:
const result = safeParseArrayMetadataV2(JSON.parse(zarrayText));
if (result.success) {
  result.value.shape; // typed as ZarrV2ArrayMetadataJSON
} else {
  result.errors; // the ErrorTree
}
```

Each document kind gets four entry points:

- `validate*(value)` → `ErrorTree` (empty tree means valid)
- `safeParse*(value)` → `{ success: true, value } | { success: false, errors }`
- `is*(value)` → type guard
- `parse*(value)` → narrowed document or throws `MetadataValidationError`
  (which carries the tree as `.errors` and its flat view as `.issues`)

## Standard Schema

Every document kind is also exported as a
[Standard Schema](https://standardschema.dev) — the interop contract
implemented by Zod, Valibot, and ArkType — so the validators plug directly
into anything that accepts standard schemas (tRPC, form libraries, ...):

```ts
import { metadataV3Schema, type StandardSchemaV1 } from "zarr-metadata";

const result = await metadataV3Schema["~standard"].validate(JSON.parse(text));
if (result.issues === undefined) {
  result.value; // ZarrV3ArrayMetadataJSON | ZarrV3GroupMetadataJSON
}
type Doc = StandardSchemaV1.InferOutput<typeof metadataV3Schema>;
```

Validation is synchronous; each issue keeps its machine-readable `kind` as
a spec-permitted extension. The schemas are `jsonValueSchema`,
`metadataFieldV3Schema`, `{array,group,consolidated}MetadataV3Schema`,
`metadataV3Schema` (the `zarr.json` dispatcher), and
`{array,group,consolidated}MetadataV2Schema`. The spec types are vendored
(the package stays dependency-free); the test suite pins them against the
official `@standard-schema/spec` package.

Covered documents: v3 array/group (`zarr.json`, including inline
`consolidated_metadata`), v2 array/group merged forms (`.zarray` /
`.zgroup` + `.zattrs`), and v2 consolidated metadata (`.zmetadata`).
The `MetadataV3` family dispatches on `node_type` for consumers handed an
arbitrary `zarr.json`.

The error-tree shape follows TypeScript validation-library convention
(compare Zod's `treeifyError` and `safeParse`) rather than the Python
package's flat problem lists; `flattenTree`/`treeOf` convert between the
two, and the flat path+kind form remains the cross-language interchange
format the conformance corpus asserts on.

Validation has two layers, and together they report what the Python
readers (`read_array_metadata_v3` and friends, zarr-metadata 0.6.0) report
in their default scope:

- The structural validators (`validate*`) check key presence, value
  shapes, fixed literals, the metadata field envelope and its extension
  names, v2 typestrs and field records, and the hierarchy a consolidated
  listing forms, without interpreting what a name means.
- The semantic layer (`validateSemanticsV3` / `validateArraySemanticsV3`)
  reads each v3 extension point through the definition that claims its
  name, organized by content: `chunk-grid/`, `chunk-key-encoding/`,
  `codec/`, and `data-type/` hold one module per interpreted name, each
  with its configuration type and rules. Then the cross-field rules run:
  the fill value against the data type, the chunk grid against the shape,
  and the codecs as a pipeline, each judged against the chunk it receives
  (array -> array, then one array -> bytes, then bytes -> bytes; `endian`
  for multi-byte values; a shard's inner chunks and its `uint64` index).
  The interpreted names are those of the reference's
  `CORE_AND_EXTENSIONS` scope: the codecs `blosc`, `bytes`, `cast_value`,
  `crc32c`, `gzip`, `scale_offset`, `sharding_indexed`, `transpose` and
  `zstd`; the `regular` and `rectilinear` grids; the `default` and `v2`
  chunk key encodings; and the core data types, `r<N>` raw bits, `string`,
  `bytes`, `numpy.datetime64`/`timedelta64` and `struct`. Unrecognized
  names are left unjudged — the extension name space is open — and so is
  everything that would depend on them.

A value of the wrong JSON type is an `invalid_type`, a value of the right
type outside its closed set or range is an `invalid_value`, and a key a
closed object does not declare is an `unknown_key`.

Known differences from the reference implementation: v2 documents get
the structural checks only (the reference also checks numpy dtype
families, fill values against the dtype, and numcodecs configurations);
two listings of one array in nested consolidated metadata are not
compared; and `JSON.parse` cannot tell `1.0` from `1`, nor two integers
past 2^53 that round to the same double, so the edges of the 64-bit
integer ranges (`int64`, `uint64`, numpy time ticks) are checked only as
precisely as a double holds them.

Consumers include the
[Zarr Metadata VS Code extension](https://github.com/d-v-b/vscode-zarr).

## How correctness is maintained

The [conformance corpus](https://github.com/d-v-b/zarr-metadata.js/tree/main/conformance) is the contract with the Python
reference implementation: shared JSON fixtures asserting the exact problem
set (loc + kind) each document must produce, for structure and semantics
alike. Both test suites run every case, the Python side against a pinned
release; a spec change updates the corpus first, turning both
implementations red until each is fixed.

## Development

Development verbs live in the [justfile](justfile) (needs
[`just`](https://github.com/casey/just), plus `uv` for the conformance
recipe); `just` with no arguments lists them:

```bash
just install       # npm install
just build         # tsc → dist/
just test          # vitest: conformance corpus + unit tests
just typecheck     # sources and tests, including type-level assertions
just conformance   # corpus vs the Python reference (the pinned PyPI release by default)
just check         # everything CI runs
```

`just conformance ../zarr-python/packages/zarr-metadata` runs the corpus
against a local zarr-python checkout instead of the released PyPI package.
Each recipe wraps a plain npm/uv command, so `just` itself is optional.

Releases are changeset-driven; see [RELEASING.md](RELEASING.md).
