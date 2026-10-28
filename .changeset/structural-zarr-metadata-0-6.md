---
"zarr-metadata": minor
---

The structural validators now report what zarr-metadata 0.6.0, the Python reference, reports, and the conformance corpus is checked against that release. This changes some verdicts:

- `must_understand: false` is refused on codecs and storage transformers, as on `data_type`, `chunk_grid` and `chunk_key_encoding`: ignoring a codec gives wrong bytes.
- Every v3 metadata field name must be a valid extension name (`^[a-z][a-z0-9-_.]+$`) or a URI.
- A key that a closed object does not declare is reported with the new kind `unknown_key` instead of `invalid_value`. A value of the wrong JSON type for a fixed literal (`zarr_format: "3"`) is `invalid_type`. A metadata field object without a `name` is `missing_key`.
- `consolidated_metadata: null` is refused. `validateGroupMetadataV3` checks only the envelope of `consolidated_metadata`; `validateConsolidatedMetadataV3` reads the listed documents, including the rules that their keys are node paths, that they form a hierarchy, and that a group listed twice reads the same in both listings. `validateMetadataV3` still reads both for a group.
- A v2 `.zarray` may hold members the spec does not define, `filters: []` is accepted, a v2 dtype string must be a NumPy typestr, a codec id must not be empty, and problems in codec ids and field records are located at the id or record. `validateConsolidatedMetadataV2` now reads each `.zarray` and `.zgroup` entry as a node, so `validateConsolidatedDocumentsV2` is deprecated; neither checks that a `.zattrs` entry with no node beside it is an object.
