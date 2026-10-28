"""Run the shared conformance corpus against the Python reference implementation.

The corpus (conformance/*.json) is the contract between the Python
`zarr-metadata` package and the TypeScript port; this script verifies the
Python side. The TypeScript side runs the same corpus via vitest
(test/conformance.test.ts).

Each corpus kind is read by the matching `zarr_metadata.model` reader in its
default scope (`CORE_AND_EXTENSIONS` for v3, `CORE_V2` for v2), so the
expected problems are the reader's full verdict: the document's structure
and the rules of every extension the scope defines. The TypeScript side
checks the same cases with its structural validators and, for v3, its
semantic layer.

Usage (with zarr-metadata importable, e.g. installed or via `uv run --with`):

    uv run --with 'zarr-metadata==0.6.0' python scripts/check_conformance.py

To test unreleased changes, install a local checkout instead:

    uv run --with /path/to/zarr-python/packages/zarr-metadata python scripts/check_conformance.py

Exits non-zero on any mismatch, printing one line per failing case.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

from zarr_metadata.model import (
    read_array_metadata_v2,
    read_array_metadata_v3,
    read_consolidated_metadata_v2,
    read_consolidated_metadata_v3,
    read_group_metadata_v2,
    read_group_metadata_v3,
)

CORPUS_DIR = Path(__file__).resolve().parent.parent / "conformance"

Loc = tuple[str | int, ...]


def v2_dtype_loc(loc: Loc) -> Loc:
    """Remove the `fields` segment zarr-metadata 0.6.0 puts after each v2 dtype in a location.

    The v2 struct dtype definition reads a list of field records as the
    configuration `{"fields": [...]}` and locates its problems in that
    configuration, so a bad record at `dtype[0]` is reported at
    `("dtype", "fields", 0)`, a location the document does not have. The
    corpus holds the document's own location, `("dtype", 0)`. Remove this
    once the reference implementation locates these problems in the
    document.
    """
    if not loc or loc[0] != "dtype":
        return loc
    out: list[str | int] = []
    in_dtype = False
    for index, part in enumerate(loc):
        if part == "fields" and in_dtype and index > 0:
            in_dtype = False
            continue
        out.append(part)
        # A record's dtype member (position 1 of a record) is a dtype again.
        in_dtype = index == 0 or (part == 1 and isinstance(loc[index - 1], int))
    return tuple(out)


def problems_of(reading: object, *, v2: bool = False) -> list[tuple[Loc, str]]:
    found = [(problem.loc, problem.kind) for problem in reading.problems]  # type: ignore[attr-defined]
    if v2:
        found = [(_relocated(loc), kind) for loc, kind in found]
    return found


def _relocated(loc: Loc) -> Loc:
    # A .zmetadata entry nests a whole .zarray, so its dtype sits two levels down.
    if len(loc) >= 3 and loc[0] == "metadata" and loc[2] == "dtype":
        return (*loc[:2], *v2_dtype_loc(loc[2:]))
    return v2_dtype_loc(loc)


VALIDATORS = {
    "v3_array": lambda doc: problems_of(read_array_metadata_v3(doc)),
    "v3_group": lambda doc: problems_of(read_group_metadata_v3(doc)),
    "v3_consolidated": lambda doc: problems_of(read_consolidated_metadata_v3(doc)),
    "v2_array": lambda doc: problems_of(read_array_metadata_v2(doc), v2=True),
    "v2_group": lambda doc: problems_of(read_group_metadata_v2(doc), v2=True),
    "v2_consolidated": lambda doc: problems_of(read_consolidated_metadata_v2(doc), v2=True),
}


def canonical(problems: list[tuple[Loc, str]]) -> list[str]:
    """Order-insensitive canonical form: sorted (loc, kind) pairs."""
    return sorted(json.dumps([list(loc), kind]) for loc, kind in problems)


def main() -> int:
    corpus_kinds = sorted(path.stem for path in CORPUS_DIR.glob("*.json"))
    if corpus_kinds != sorted(VALIDATORS):
        print(f"corpus kinds {corpus_kinds} != registered validators {sorted(VALIDATORS)}")
        return 1
    failures = 0
    total = 0
    for kind, validator in VALIDATORS.items():
        cases = json.loads((CORPUS_DIR / f"{kind}.json").read_text())
        # The corpus is the cross-language contract; a truncated fixture file
        # must fail loudly, not weaken the contract silently.
        valid_count = sum(1 for case in cases if not case["problems"])
        invalid_count = len(cases) - valid_count
        if valid_count == 0 or invalid_count == 0:
            failures += 1
            print(
                f"FAIL [{kind}] corpus must hold at least one valid and one invalid case "
                f"(valid={valid_count}, invalid={invalid_count})"
            )
        for case in cases:
            total += 1
            expected = canonical(
                [(tuple(problem["loc"]), problem["kind"]) for problem in case["problems"]]
            )
            actual = canonical(validator(case["document"]))
            if actual != expected:
                failures += 1
                print(f"FAIL [{kind}] {case['description']}")
                print(f"  expected: {expected}")
                print(f"  actual:   {actual}")
    print(f"{total - failures}/{total} conformance cases passed (python)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
