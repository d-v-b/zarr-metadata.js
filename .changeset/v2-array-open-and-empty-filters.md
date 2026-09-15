---
"zarr-metadata": minor
---

Two v2 structural rules that were stricter than the spec are relaxed,
with the shared conformance corpus updated first: members outside the
`.zarray` definition are tolerated (the spec says other keys "SHOULD NOT
be present ... and SHOULD be ignored", unlike `.zgroup`'s "MUST NOT"; the
v2 semantic layer now reports them as advisories instead), and
`filters: []` is accepted (the spec says "a list of JSON objects providing
codec configurations, or null" with no minimum). Both changes turn the
Python reference implementation's conformance run red until it follows.
