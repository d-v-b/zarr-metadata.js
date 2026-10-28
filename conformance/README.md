# Conformance corpus

Shared test fixtures for the Python `zarr-metadata` package (the reference
implementation) and the TypeScript `zarr-metadata` port. Both test suites run
every case in this directory; a spec change updates the corpus first, turning
both implementations red until each is fixed.

## Format

One JSON file per document kind, each an array of cases:

| file | document | Python reader | TypeScript |
| - | - | - | - |
| `v3_array.json` | a v3 array `zarr.json` | `read_array_metadata_v3` | `validateArrayMetadataV3` + `validateArraySemanticsV3` |
| `v3_group.json` | a v3 group `zarr.json` | `read_group_metadata_v3` | `validateGroupMetadataV3` |
| `v3_consolidated.json` | a v3 group's `consolidated_metadata` member | `read_consolidated_metadata_v3` | `validateConsolidatedMetadataV3` + the semantic layer on each listed array |
| `v2_array.json` | a merged `.zarray` + `.zattrs` | `read_array_metadata_v2` | `validateArrayMetadataV2` |
| `v2_group.json` | a merged `.zgroup` + `.zattrs` | `read_group_metadata_v2` | `validateGroupMetadataV2` |
| `v2_consolidated.json` | a `.zmetadata` | `read_consolidated_metadata_v2` | `validateConsolidatedMetadataV2` |

Each Python reader runs in its default scope (`CORE_AND_EXTENSIONS` for v3,
`CORE_V2` for v2), so the expected problems are its full verdict: structure,
and the rules of every extension the scope defines. The TypeScript package
has no v2 semantic layer yet, so v2 fixtures keep their dtypes, fill values
and codec configurations valid apart from what each case tests.

A case looks like this:

```json
{
  "description": "what this case exercises",
  "document": { "the": "metadata document under test" },
  "problems": [
    { "loc": ["codecs", 0, "name"], "kind": "invalid_type" }
  ]
}
```

- An empty `problems` array means the document is valid.
- Expected problems assert on `loc` (path from document root) and `kind`
  (`missing_key` | `invalid_type` | `invalid_value` | `invalid_json` |
  `unknown_key`) only.
  Human-readable messages are deliberately NOT asserted: they legitimately
  differ between languages (Python `repr` vs JS formatting).
- Comparison is order-insensitive: implementations may emit problems in any
  order, but must emit exactly this multiset.

## Constraints on fixtures

- Documents must be expressible as JSON text (the corpus is JSON), so cases
  exercising non-JSON runtime values (functions, NaN floats, non-string keys)
  belong in each implementation's own unit tests, not here.
- No fixture may hinge on JSON int-vs-float spelling (`3` vs `3.0`):
  `JSON.parse` collapses both to the same number in JavaScript, while Python
  distinguishes them. Python rejects `zarr_format: 3.0`; JS structurally
  cannot.

- The Python runner removes one known location defect of the reference
  implementation before comparing: zarr-metadata 0.6.0 reports a problem in
  a v2 field record at `["dtype", "fields", 0]`, a location the document
  does not have, where the corpus holds `["dtype", 0]`.

## Runners

- TypeScript: `test/conformance.test.ts` (vitest).
- Python: `scripts/check_conformance.py` (run against an installed or local
  `zarr-metadata`).
