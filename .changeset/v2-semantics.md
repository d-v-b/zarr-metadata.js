---
"zarr-metadata": minor
---

New TS-only v2 semantic layer, `validateSemanticsV2` / `validateArraySemanticsV2`
(and the `NumpyTypestr` type). It interprets what the structural validators deliberately
leave alone: the `dtype` typestr grammar the v2 spec adopts (byte order
"MUST be specified", kind code, NumPy item size, datetime/timedelta units
"MUST" be included), structured-dtype field rules (unique names,
non-negative subarray shapes, recursively), and the `fill_value`
encodings the spec fixes per type (`"NaN"`/`"Infinity"`/`"-Infinity"` for
floats, base64 for fixed-length byte strings and structured types,
integer ranges, int64-or-`"NaT"` for temporal types). `validateSemanticsV2`
also walks the `.zarray` entries of a `.zmetadata` document.
