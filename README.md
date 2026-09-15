# zarr-metadata (TypeScript)

Spec-defined metadata types and structural validators for
[Zarr](https://zarr.dev) v2 and v3, in TypeScript. A port of the Python
[`zarr-metadata`](https://pypi.org/project/zarr-metadata/) package (the
reference implementation), kept in lockstep by a shared conformance corpus.

```ts
import {
  decodeStoreJson,
  validateMetadataV3,
  safeParseArrayMetadataV2,
  isEmptyTree,
  flattenTree,
} from "zarr-metadata";

// Validation produces a tree of errors mirroring the document's shape;
// an empty tree means the document is valid.
// decodeStoreJson is JSON.parse, but keeps integers beyond
// Number.MAX_SAFE_INTEGER exact (as bigints) so int64/uint64 checks see
// the value the document spells.
const errors = validateMetadataV3(decodeStoreJson(text));
if (!isEmptyTree(errors)) {
  errors.children.get("codecs"); // the subtree of codec problems
  flattenTree(errors); // the flat view, for diagnostics:
  // [{ path: ["codecs"], kind: "invalid_value", message: "expected at least one codec" }]
}

// Or the discriminated-union form:
const result = safeParseArrayMetadataV2(decodeStoreJson(zarrayText));
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
import { decodeStoreJson, metadataV3Schema, type StandardSchemaV1 } from "zarr-metadata";

const result = await metadataV3Schema["~standard"].validate(decodeStoreJson(text));
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

The structural validators check key presence, value shapes, and fixed
literals without interpreting extension points, matching the Python
package's layering. The semantic layer (`validateSemanticsV3` /
`validateArraySemanticsV3`) is TS-only and sits on top, organized by
content: `chunk-grid/`, `codec/`, and `data-type/` hold one module per
interpreted name, each with its syntax (configuration and fill-value
types) and semantics (required members, cross-field prose rules — grid
arity and sums, transpose permutations, sharding divisibility, fill_value
vs data type). Interpreted data types cover the core scalars, the `r<N>`
raw-bits family, and the established zarr-extensions conventions —
`string`, `bytes`, `numpy.datetime64`/`timedelta64`, and `struct` (whose
fill is judged per field, recursively). `semantics.ts` is the
document-walking orchestrator. Unrecognized names are skipped — the
extension name space is open.

Consumers include the
[Zarr Metadata VS Code extension](https://github.com/d-v-b/vscode-zarr).

## How correctness is maintained

The [conformance corpus](https://github.com/d-v-b/zarr-metadata.js/tree/main/conformance) is the contract with the Python
reference implementation: shared JSON fixtures asserting the exact problem
set (loc + kind) each document must produce. Both test suites run every
case; a spec change updates the corpus first, turning both implementations
red until each is fixed.

## Development

Development verbs live in the [justfile](justfile) (needs
[`just`](https://github.com/casey/just), plus `uv` for the conformance
recipe); `just` with no arguments lists them:

```bash
just install       # npm install
just build         # tsc → dist/
just test          # vitest: conformance corpus + unit tests
just typecheck     # sources and tests, including type-level assertions
just conformance   # corpus vs the Python reference (PyPI by default)
just check         # everything CI runs
```

`just conformance ../zarr-python/packages/zarr-metadata` runs the corpus
against a local zarr-python checkout instead of the released PyPI package.
Each recipe wraps a plain npm/uv command, so `just` itself is optional.

Releases are changeset-driven; see [RELEASING.md](RELEASING.md).
