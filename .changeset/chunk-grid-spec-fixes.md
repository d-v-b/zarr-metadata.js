---
"zarr-metadata": patch
---

Chunk grid semantics now follow their specs: a `rectilinear` grid's chunk
sizes along a dimension may sum to more than the dimension length ("MUST
equal or exceed", so resized arrays whose trailing chunks overflow are
valid — previously an exact sum was required), and a `regular` grid's
`chunk_shape` entries must be positive ("Chunk sizes must be greater than
zero" — previously 0 and negative sizes passed).
