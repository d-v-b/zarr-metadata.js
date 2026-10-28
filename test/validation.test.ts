/**
 * TS-specific unit tests: behavior the conformance corpus cannot express
 * because its fixtures must be JSON text (non-JSON runtime values), plus the
 * tree/parse/guard/error API surface.
 */
import { describe, expect, it } from "vitest";

import {
  flattenTree,
  formatTree,
  isArrayMetadataV3,
  isEmptyTree,
  MetadataValidationError,
  mustUnderstandExtensionFieldsV3,
  parseArrayMetadataV3,
  parseJson,
  safeParseArrayMetadataV3,
  treeOf,
  validateJson,
  validateMetadataV3,
} from "../src/index.js";

const VALID_ARRAY = {
  zarr_format: 3,
  node_type: "array",
  shape: [10],
  data_type: "float64",
  chunk_grid: { name: "regular", configuration: { chunk_shape: [5] } },
  chunk_key_encoding: "default",
  fill_value: 0,
  codecs: ["bytes"],
};

describe("the error tree", () => {
  it("is empty exactly when validation succeeds", () => {
    expect(isEmptyTree(validateMetadataV3(VALID_ARRAY))).toBe(true);
    expect(isEmptyTree(validateMetadataV3({ zarr_format: 3 }))).toBe(false);
  });

  it("mirrors the document shape, with issues at the offending nodes", () => {
    const tree = validateMetadataV3({ ...VALID_ARRAY, codecs: [42] });
    expect(tree.issues).toEqual([]);
    const codecEntry = tree.children.get("codecs")?.children.get(0);
    expect(codecEntry?.issues).toEqual([
      {
        kind: "invalid_type",
        message: "expected a metadata field (string or extension object)",
      },
    ]);
  });

  it("round-trips through flattenTree/treeOf", () => {
    const tree = validateMetadataV3({ zarr_format: 3, node_type: "array" });
    const flat = flattenTree(tree);
    expect(flat).toHaveLength(6);
    expect(flat.every((issue) => issue.kind === "missing_key")).toBe(true);
    expect(flattenTree(treeOf(flat))).toEqual(flat);
  });
});

describe("validateJson", () => {
  it("rejects non-finite numbers at their path", () => {
    expect(flattenTree(validateJson({ a: [1, Infinity] }))).toEqual([
      { path: ["a", 1], message: "non-finite number Infinity is not JSON", kind: "invalid_value" },
    ]);
  });

  it("rejects non-JSON runtime values with their path", () => {
    const issues = flattenTree(validateJson({ a: { b: undefined } }));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.path).toEqual(["a", "b"]);
    expect(issues[0]!.kind).toBe("invalid_type");
  });
});

describe("parse and safeParse", () => {
  it("parse throws MetadataValidationError carrying the whole tree", () => {
    expect.assertions(3);
    try {
      parseArrayMetadataV3({ zarr_format: 3, node_type: "array" });
    } catch (error) {
      expect(error).toBeInstanceOf(MetadataValidationError);
      const { issues } = error as MetadataValidationError;
      expect(issues).toHaveLength(6);
      expect(issues.every((issue) => issue.kind === "missing_key")).toBe(true);
    }
  });

  it("safeParse returns a discriminated union", () => {
    const ok = safeParseArrayMetadataV3(VALID_ARRAY);
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.value).toBe(VALID_ARRAY);
    const bad = safeParseArrayMetadataV3({ ...VALID_ARRAY, codecs: [] });
    expect(bad.success).toBe(false);
    if (!bad.success) {
      expect(flattenTree(bad.errors)).toEqual([
        {
          path: ["codecs"],
          message: "expected an array -> bytes codec, got none",
          kind: "invalid_value",
        },
      ]);
    }
  });

  it("parse returns the input narrowed on success", () => {
    expect(parseArrayMetadataV3(VALID_ARRAY)).toBe(VALID_ARRAY);
    expect(parseJson([1, "a", null])).toEqual([1, "a", null]);
  });
});

describe("type guards", () => {
  it("accept valid and reject invalid documents", () => {
    expect(isArrayMetadataV3(VALID_ARRAY)).toBe(true);
    expect(isArrayMetadataV3({ ...VALID_ARRAY, codecs: [] })).toBe(false);
    expect(isArrayMetadataV3("not a doc")).toBe(false);
  });
});

describe("validateMetadataV3 dispatcher", () => {
  it("routes arrays and groups to the right validator", () => {
    expect(isEmptyTree(validateMetadataV3(VALID_ARRAY))).toBe(true);
    expect(isEmptyTree(validateMetadataV3({ zarr_format: 3, node_type: "group" }))).toBe(true);
  });

  it("reports a missing or unusable node_type", () => {
    expect(flattenTree(validateMetadataV3({ zarr_format: 3 }))).toEqual([
      { path: ["node_type"], message: "missing required key", kind: "missing_key" },
    ]);
    const issues = flattenTree(validateMetadataV3({ zarr_format: 3, node_type: "dataset" }));
    expect(issues).toHaveLength(1);
    expect(issues[0]!.kind).toBe("invalid_value");
  });

  it("rejects non-mapping documents", () => {
    expect(flattenTree(validateMetadataV3([]))[0]!.kind).toBe("invalid_type");
  });
});

describe("formatTree", () => {
  it("renders one dotted-path line per issue, with <root> for an empty path", () => {
    const tree = treeOf([
      { path: ["codecs", 0, "name"], message: "m", kind: "invalid_type" },
      { path: [], message: "r", kind: "invalid_type" },
    ]);
    // flattenTree emits a node's own issues before its children's, so the
    // root-level issue leads.
    expect(formatTree(tree)).toBe("<root>: r\ncodecs.0.name: m");
  });
});

describe("mustUnderstandExtensionFieldsV3", () => {
  it("reports obligated extension keys and skips waived and standard ones", () => {
    expect(
      mustUnderstandExtensionFieldsV3({
        ...VALID_ARRAY,
        "ext:waived": { must_understand: false, payload: 1 },
        "ext:object": { name: "thing" },
        "ext:bare": 5,
      }),
    ).toEqual(["ext:object", "ext:bare"]);
    expect(mustUnderstandExtensionFieldsV3(VALID_ARRAY)).toEqual([]);
    // consolidated_metadata is a recognized convention on groups...
    expect(
      mustUnderstandExtensionFieldsV3({
        zarr_format: 3,
        node_type: "group",
        consolidated_metadata: null,
        extra: true,
      }),
    ).toEqual(["extra"]);
    // ...but not on arrays.
    expect(
      mustUnderstandExtensionFieldsV3({ ...VALID_ARRAY, consolidated_metadata: null }),
    ).toEqual(["consolidated_metadata"]);
  });

  it("returns nothing for values that are not v3 documents", () => {
    expect(mustUnderstandExtensionFieldsV3(42)).toEqual([]);
    expect(mustUnderstandExtensionFieldsV3({ zarr_format: 2, weird: 1 })).toEqual([]);
  });
});

describe("validateConsolidatedDocumentsV2", () => {
  it("validates entries by key suffix, leaving unknown suffixes and the envelope layer alone", async () => {
    const { validateConsolidatedDocumentsV2 } = await import("../src/index.js");
    const good = {
      zarr_consolidated_format: 1,
      metadata: {
        ".zgroup": { zarr_format: 2 },
        "a/.zarray": {
          zarr_format: 2, shape: [10], chunks: [5], dtype: "<f8",
          compressor: null, fill_value: 0, order: "C", filters: null,
        },
        "a/.zattrs": { units: "m" },
        "a/whatever.json": { anything: true },
      },
    };
    expect(isEmptyTree(validateConsolidatedDocumentsV2(good))).toBe(true);
    // Non-envelope values produce nothing (the envelope validator owns those).
    expect(isEmptyTree(validateConsolidatedDocumentsV2(42))).toBe(true);
    expect(isEmptyTree(validateConsolidatedDocumentsV2({ metadata: "nope" }))).toBe(true);
  });

  it("reports broken node documents at their entry paths", async () => {
    const { validateConsolidatedDocumentsV2 } = await import("../src/index.js");
    const issues = flattenTree(
      validateConsolidatedDocumentsV2({
        zarr_consolidated_format: 1,
        metadata: {
          "a/.zarray": {
            zarr_format: 2, shape: [10], chunks: [5, 5], dtype: "<f8",
            compressor: null, fill_value: 0, order: "C", filters: null,
          },
          "b/.zgroup": { zarr_format: 3 },
          "b/.zattrs": [1, 2],
        },
      }),
    ).map((issue) => [issue.path.join("."), issue.kind]);
    expect(issues).toEqual([
      ["metadata.a/.zarray.chunks", "invalid_value"],
      ["metadata.b/.zgroup.zarr_format", "invalid_value"],
      ["metadata.b/.zattrs", "invalid_type"],
    ]);
  });

  it("leaves a .zattrs with no sibling node unchecked, as the reference does", async () => {
    const { validateConsolidatedDocumentsV2 } = await import("../src/index.js");
    expect(
      flattenTree(validateConsolidatedDocumentsV2({ zarr_consolidated_format: 1, metadata: { "a/.zattrs": 5 } })),
    ).toEqual([]);
  });

  it("rejects an attributes member inside on-disk .zarray and .zgroup entries", async () => {
    const { validateConsolidatedDocumentsV2 } = await import("../src/index.js");
    const issues = flattenTree(
      validateConsolidatedDocumentsV2({
        zarr_consolidated_format: 1,
        metadata: {
          ".zgroup": { zarr_format: 2, attributes: { a: 1 } },
        },
      }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]!.path).toEqual(["metadata", ".zgroup", "attributes"]);
    expect(issues[0]!.kind).toBe("unknown_key");
    expect(issues[0]!.message).toContain("belong in .zattrs");
  });
});
