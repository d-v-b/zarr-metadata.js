/**
 * v2 semantic-layer tests (dtype contents and fill-value encodings). This
 * layer has no Python counterpart, so it is covered here rather than by
 * the conformance corpus.
 */
import { describe, expect, it } from "vitest";

import {
  flattenTree,
  isEmptyTree,
  validateArraySemanticsV2,
  validateSemanticsV2,
} from "../src/index.js";

function array(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    zarr_format: 2,
    shape: [100],
    chunks: [10],
    dtype: "<f8",
    compressor: null,
    fill_value: null,
    order: "C",
    filters: null,
    ...overrides,
  };
}

function issues(value: unknown): Array<{ path: ReadonlyArray<string | number>; message: string }> {
  return flattenTree(validateArraySemanticsV2(value)).map(({ path, message }) => ({ path, message }));
}

function messages(value: unknown): string[] {
  return issues(value).map((issue) => issue.message);
}

describe("validateArraySemanticsV2", () => {
  it("accepts every spec-valid dtype and fill_value combination", () => {
    const valid = [
      // the spec's own typestr examples, with byte order "|" where not relevant
      ...["<f8", ">i4", "|b1", "|S12", "<M8[ns]", "<m8[10s]", "|V16", "<U4", "<c16", "<f16", "|u1"].map(
        (dtype) => array({ dtype }),
      ),
      array({ dtype: "<f8", fill_value: 0 }),
      array({ dtype: "<f8", fill_value: 1.5 }),
      array({ dtype: "<f8", fill_value: "NaN" }),
      array({ dtype: "<f4", fill_value: "Infinity" }),
      array({ dtype: "<f2", fill_value: "-Infinity" }),
      array({ dtype: "<c8", fill_value: [1, "NaN"] }),
      array({ dtype: "<c8", fill_value: 2 }),
      array({ dtype: "|i1", fill_value: -128 }),
      array({ dtype: "|u1", fill_value: 255 }),
      array({ dtype: "<i8", fill_value: -9223372036854775808n }),
      array({ dtype: "<u8", fill_value: 18446744073709551615n }),
      array({ dtype: "|b1", fill_value: false }),
      array({ dtype: "|b1", fill_value: 0 }),
      array({ dtype: "|S3", fill_value: "AQID" }),
      array({ dtype: "|V4", fill_value: "AAAAAA==" }),
      array({ dtype: "<U2", fill_value: "hi" }),
      array({ dtype: "<M8[ns]", fill_value: 0 }),
      array({ dtype: "<m8[s]", fill_value: "NaT" }),
      // the spec's structured examples, and a base64 structured fill
      array({ dtype: [["r", "|u1"], ["g", "|u1"], ["b", "|u1"]], fill_value: "AAAA" }),
      array({ dtype: [["x", "<f4"], ["y", "<f4"], ["z", "<f4", [2, 2]]] }),
      array({ dtype: [["foo", "<f4"], ["bar", [["baz", "<f4"], ["qux", "<i4"]]]] }),
      // structurally invalid values are the structural layer's problem
      array({ dtype: 5, fill_value: {} }),
      array({ dtype: [["x"]], fill_value: null }),
    ];
    for (const document of valid) {
      expect(isEmptyTree(validateArraySemanticsV2(document)), JSON.stringify(document, (_k, v) => (typeof v === "bigint" ? `${v}n` : v))).toBe(true);
    }
  });

  it("reports members outside the array document definition as advisories", () => {
    expect(issues(array({ foo: 1, attributes: { merged: true } }))).toEqual([
      {
        path: ["foo"],
        message: "unexpected document member (the spec says other keys SHOULD NOT be present)",
      },
    ]);
  });

  it("rejects a typestr without a byte order", () => {
    expect(messages(array({ dtype: "f8" }))).toEqual([
      'the byte order ("<", ">", or "|") must be specified, got "f8"',
    ]);
  });

  it("rejects a typestr that does not follow the grammar", () => {
    for (const dtype of ["float64", "", "<f", "<q8", "<f8 ", "=f8"]) {
      expect(messages(array({ dtype })), dtype).toEqual([
        `expected a NumPy typestr (byte order, type code, byte count, e.g. "<f8"), got ${JSON.stringify(dtype)}`,
      ]);
    }
  });

  it("rejects an item size NumPy does not define for the kind", () => {
    expect(messages(array({ dtype: "<i3" }))).toEqual([
      'no "i" type is 3 bytes wide (expected 1, 2, 4, 8), got "<i3"',
    ]);
  });

  it("rejects datetime and timedelta types without units", () => {
    expect(messages(array({ dtype: "<M8" }))).toEqual([
      'datetime ("M") and timedelta ("m") types must include units in square brackets, e.g. "<M8[ns]", got "<M8"',
    ]);
    expect(messages(array({ dtype: "<m8[xx]" }))).toEqual([
      'expected a NumPy typestr (byte order, type code, byte count, e.g. "<f8"), got "<m8[xx]"',
    ]);
  });

  it("rejects units on non-temporal types", () => {
    expect(messages(array({ dtype: "<i4[ns]" }))).toEqual([
      'units apply only to datetime ("M") and timedelta ("m") types, got "<i4[ns]"',
    ]);
  });

  it("rejects duplicate field names, bad field types, and negative subarray shapes in structured dtypes", () => {
    expect(
      issues(
        array({
          dtype: [
            ["x", "<f4"],
            ["x", "f4", [-2]],
            ["y", [["a", "<i4"], ["a", "<i4"]]],
          ],
        }),
      ),
    ).toEqual([
      { path: ["dtype", 1, 0], message: 'duplicate field name "x"' },
      { path: ["dtype", 1, 1], message: 'the byte order ("<", ">", or "|") must be specified, got "f4"' },
      { path: ["dtype", 1, 2], message: "expected non-negative integers" },
      { path: ["dtype", 2, 1, 1, 0], message: 'duplicate field name "a"' },
    ]);
  });

  it("rejects float fills that are not numbers or the three sentinels", () => {
    for (const fill_value of ["nan", "inf", "+Infinity", "1.5", {}, [1]]) {
      expect(messages(array({ dtype: "<f8", fill_value })), JSON.stringify(fill_value)).toEqual([
        'expected a number, "NaN", "Infinity", or "-Infinity" for dtype "<f8"',
      ]);
    }
  });

  it("rejects complex fills that are neither float fills nor [real, imaginary] pairs", () => {
    expect(messages(array({ dtype: "<c16", fill_value: [1, 2, 3] }))).toEqual([
      'expected a number, "NaN", "Infinity", or "-Infinity", or a two-element [real, imaginary] array of those, for dtype "<c16"',
    ]);
  });

  it("rejects integer fills outside the type's range or not integral", () => {
    expect(messages(array({ dtype: "|u1", fill_value: 256 }))).toEqual([
      'expected an integer in [0, 255] for dtype "|u1"',
    ]);
    expect(messages(array({ dtype: "<i4", fill_value: 1.5 }))).toEqual([
      'expected an integer in [-2147483648, 2147483647] for dtype "<i4"',
    ]);
    expect(messages(array({ dtype: "<i8", fill_value: 9223372036854775808n }))).toEqual([
      'expected an integer in [-9223372036854775808, 9223372036854775807] for dtype "<i8"',
    ]);
  });

  it("rejects non-base64 fills for fixed-length byte strings", () => {
    expect(messages(array({ dtype: "|S3", fill_value: "!!not base64!!" }))).toEqual([
      'expected a base64 string fill value for dtype "|S3"',
    ]);
    expect(messages(array({ dtype: "|S3", fill_value: 0 }))).toEqual([
      'expected a base64 string fill value for dtype "|S3"',
    ]);
  });

  it("rejects non-base64 fills for structured dtypes", () => {
    expect(messages(array({ dtype: [["r", "|u1"]], fill_value: 0 }))).toEqual([
      "expected a base64 string fill value for a structured dtype",
    ]);
  });

  it("rejects temporal fills that are not int64 integers or NaT", () => {
    expect(messages(array({ dtype: "<M8[ns]", fill_value: "2020-01-01" }))).toEqual([
      'expected an int64 integer or "NaT" for dtype "<M8[ns]"',
    ]);
  });

  it("rejects non-scalar fills where the spec fixes no encoding", () => {
    expect(messages(array({ dtype: "|b1", fill_value: [false] }))).toEqual([
      'expected a scalar fill value for dtype "|b1"',
    ]);
  });
});

describe("validateSemanticsV2", () => {
  it("applies the array rules to a .zarray document and to .zarray entries of .zmetadata", () => {
    expect(flattenTree(validateSemanticsV2(array({ dtype: "f8" }))).map((i) => i.path)).toEqual([
      ["dtype"],
    ]);
    const consolidated = {
      zarr_consolidated_format: 1,
      metadata: {
        ".zgroup": { zarr_format: 2 },
        "a/.zarray": array({ dtype: "<f8", fill_value: "nan" }),
        "a/.zattrs": { dtype: "f8" },
        "b/.zarray": array({}),
      },
    };
    expect(flattenTree(validateSemanticsV2(consolidated))).toEqual([
      {
        path: ["metadata", "a/.zarray", "fill_value"],
        message: 'expected a number, "NaN", "Infinity", or "-Infinity" for dtype "<f8"',
        kind: "invalid_value",
      },
    ]);
  });
});
