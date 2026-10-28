---
"zarr-metadata": minor
---

Stores written by zarr-python with a NaN or infinite number in attributes can now be read. zarr-python writes such a value (an xarray `_FillValue` or a CF `missing_value`, for example) as a bare `NaN`, `Infinity` or `-Infinity`, which `loadStoreJson` refused as invalid JSON. It now reads these tokens, and the validators accept non-finite numbers in attributes, in extension fields nothing interprets, and in `.zattrs` entries, as zarr-metadata 0.6.0 does, while still refusing them wherever the spec interprets a value, such as `fill_value`. `dumpStoreJson(value, { allowNonFinite: true })` writes them back as the same tokens.
