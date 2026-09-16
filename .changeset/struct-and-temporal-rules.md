---
"zarr-metadata": minor
---

The semantic layer now applies the zarr-extensions prose rules on `struct`
configurations — field names must be unique, variable-length types
(`string`, `bytes`) cannot be field types, and core data types must be
spelled as strings — recursively for nested structs, and range-checks
`numpy.datetime64`/`numpy.timedelta64` fill values to `[-2^63, 2^63 - 1]`.
Data type descriptors gain an optional `configIssues` hook (with a
`ConfigContext`) for such configuration-level rules.
