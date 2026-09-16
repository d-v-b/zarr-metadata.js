---
"zarr-metadata": minor
---

Integers too large for a `number` are now kept exact. The new
`decodeStoreJson(text | bytes)` (also used by `loadStoreJson`) is
`JSON.parse` except that an integer literal beyond
`Number.MAX_SAFE_INTEGER` decodes to a `bigint`; `bigint` is accepted as a
JSON integer throughout (`JSONValue`, `validateJson`, dimension
sequences), `dumpStoreJson` writes bigints as exact integer literals, and
integer fill values are range-checked exactly — so an `int64` fill of
`9223372036854775808` (2^63) is now rejected, where `JSON.parse` rounded it
to the same double as the valid 2^63 - 1. Number fills beyond the safe
range (from bare `JSON.parse`) keep the previous, lenient double-precision
comparison. Exact decoding needs `JSON.parse` source-text access (Node >=
21, current browsers); elsewhere such literals round as before.
