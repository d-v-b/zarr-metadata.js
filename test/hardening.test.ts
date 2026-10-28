/**
 * Tests for behavior the conformance corpus cannot express because its
 * fixtures must be JSON text: hostile runtime values (depth bombs, cycles,
 * BigInt, non-plain objects) and the byte-level store entry points.
 */
import { describe, expect, it } from "vitest";

import {
  dumpStoreJson,
  flattenTree,
  isGroupMetadataV3,
  isJson,
  loadStoreJson,
  MAX_JSON_DEPTH,
  MetadataValidationError,
  parseJson,
  validateArrayMetadataV2,
  validateArrayMetadataV3,
  validateConsolidatedMetadataV2,
  validateConsolidatedMetadataV3,
  validateGroupMetadataV3,
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

function nest(depth: number): unknown {
  let value: unknown = 1;
  for (let i = 0; i < depth; i++) value = [value];
  return value;
}

describe("nesting depth cap", () => {
  it("accepts documents up to MAX_JSON_DEPTH and reports beyond it", () => {
    expect(flattenTree(validateJson(nest(MAX_JSON_DEPTH)))).toEqual([]);
    const problems = flattenTree(validateJson(nest(MAX_JSON_DEPTH + 1)));
    expect(problems).toHaveLength(1);
    expect(problems[0]!.kind).toBe("invalid_value");
    expect(problems[0]!.message).toContain("nesting depth");
  });

  it("keeps guards total on depth bombs that JSON.parse accepts", () => {
    const deep = JSON.parse(
      `{"zarr_format":3,"node_type":"group","attributes":{"x":${"[".repeat(3000)}1${"]".repeat(3000)}}}`,
    );
    expect(isGroupMetadataV3(deep)).toBe(false);
  });

  it("terminates on circular object graphs instead of overflowing", () => {
    const cycle: Record<string, unknown> = {};
    cycle["self"] = cycle;
    expect(isJson(cycle)).toBe(false);
    const arrayCycle: unknown[] = [];
    arrayCycle.push(arrayCycle);
    expect(isJson(arrayCycle)).toBe(false);
  });

  it("caps the independent dtype recursion route", () => {
    let dtype: unknown = "<i4";
    for (let i = 0; i < 200; i++) dtype = [["f", dtype]];
    const problems = flattenTree(
      validateArrayMetadataV2({
        zarr_format: 2,
        shape: [1],
        chunks: [1],
        dtype,
        compressor: null,
        fill_value: 0,
        order: "C",
        filters: null,
      }),
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]!.path[0]).toBe("dtype");
    expect(problems[0]!.kind).toBe("invalid_value");
    expect(problems[0]!.message).toContain("nesting depth");
  });
});

describe("non-plain objects are not mappings", () => {
  it("rejects Date/Map/Set/class instances as non-JSON", () => {
    expect(isJson(new Date())).toBe(false);
    expect(isJson(new Map([["a", 1]]))).toBe(false);
    expect(isJson(new Set([1]))).toBe(false);
    class Thing {}
    expect(isJson(new Thing())).toBe(false);
    expect(() => parseJson(new Map())).toThrow(MetadataValidationError);
  });

  it("still accepts null-prototype objects (legitimate map-likes)", () => {
    const doc = Object.assign(Object.create(null) as Record<string, unknown>, { a: 1 });
    expect(isJson(doc)).toBe(true);
  });

  it("reports a single root invalid_type for a non-mapping document, like Python", () => {
    expect(flattenTree(validateArrayMetadataV2(new Date()))).toEqual([
      { path: [], message: "expected an object", kind: "invalid_type" },
    ]);
  });

  it("rejects a Date in attributes instead of validating it as empty", () => {
    const problems = flattenTree(validateArrayMetadataV3({ ...VALID_ARRAY, attributes: new Date() }));
    expect(problems).toEqual([
      { path: ["attributes"], message: "expected an object with string keys", kind: "invalid_type" },
    ]);
  });
});

describe("BigInt", () => {
  it("is reported as non-JSON instead of crashing the renderer", () => {
    expect(isJson(1n)).toBe(false);
    const problems = flattenTree(validateJson({ a: 1n }));
    expect(problems).toHaveLength(1);
    expect(problems[0]!.path).toEqual(["a"]);
    expect(problems[0]!.kind).toBe("invalid_type");
    expect(problems[0]!.message).toContain("1n");
  });
});

describe("loadStoreJson", () => {
  const zarrJson = JSON.stringify(VALID_ARRAY);

  it("decodes text and bytes from plain-object and Map stores", () => {
    expect(loadStoreJson({ "zarr.json": zarrJson }, "zarr.json")).toEqual(VALID_ARRAY);
    const bytes = new TextEncoder().encode(zarrJson);
    expect(loadStoreJson(new Map([["zarr.json", bytes]]), "zarr.json")).toEqual(VALID_ARRAY);
  });

  it("reports a missing store key as missing_key at the key", () => {
    expect.assertions(2);
    try {
      loadStoreJson({}, "zarr.json");
    } catch (error) {
      expect(error).toBeInstanceOf(MetadataValidationError);
      expect((error as MetadataValidationError).issues).toEqual([
        { path: ["zarr.json"], message: "missing store key", kind: "missing_key" },
      ]);
    }
  });

  it("reads the bare NaN, Infinity and -Infinity tokens zarr-python writes, outside strings only", () => {
    const text = '{"a": NaN, "b": [Infinity, -Infinity], "c": "NaN \\" Infinity", "NaN": 1}';
    expect(loadStoreJson({ key: text }, "key")).toEqual({
      a: NaN,
      b: [Infinity, -Infinity],
      c: 'NaN " Infinity',
      NaN: 1,
    });
  });

  it("reports malformed JSON, invalid UTF-8, and misplaced constants as invalid_json", () => {
    for (const raw of ["{", new Uint8Array([0xff, 0xfe]), "[1 NaN]", "NaNa", "nan", '{NaN: 1}', '{"a": {Infinity: []}}']) {
      let kind: string | undefined;
      try {
        loadStoreJson({ key: raw }, "key");
      } catch (error) {
        kind = (error as MetadataValidationError).issues[0]?.kind;
      }
      expect(kind).toBe("invalid_json");
    }
  });
});

describe("dumpStoreJson", () => {
  it("round-trips through loadStoreJson", () => {
    const bytes = dumpStoreJson(VALID_ARRAY, { indent: 2 });
    expect(loadStoreJson({ "zarr.json": bytes }, "zarr.json")).toEqual(VALID_ARRAY);
  });

  it("throws on non-JSON values instead of silently writing null", () => {
    expect(() => dumpStoreJson({ fill_value: NaN })).toThrow(MetadataValidationError);
    expect(() => dumpStoreJson(new Map())).toThrow(MetadataValidationError);
  });

  it("writes non-finite numbers as bare tokens when asked, and reads them back", () => {
    const document = { ...VALID_ARRAY, attributes: { _FillValue: NaN, range: [-Infinity, Infinity] } };
    const bytes = dumpStoreJson(document, { allowNonFinite: true });
    expect(new TextDecoder().decode(bytes)).toContain('"_FillValue":NaN,"range":[-Infinity,Infinity]');
    expect(loadStoreJson({ "zarr.json": bytes }, "zarr.json")).toEqual(document);
    expect(() => dumpStoreJson(new Map(), { allowNonFinite: true })).toThrow(MetadataValidationError);
  });
});

describe("validateMetadataV3 on a group", () => {
  it("reports a problem in a listed document once", () => {
    const listed = { ...VALID_ARRAY, attributes: { a: new Map() } };
    const problems = flattenTree(
      validateMetadataV3({
        zarr_format: 3,
        node_type: "group",
        consolidated_metadata: { kind: "inline", must_understand: false, metadata: { a: listed } },
      }),
    ).map((issue) => `${issue.path.join(".")}: ${issue.kind}`);
    expect(problems).toEqual(["consolidated_metadata.metadata.a.attributes.a: invalid_type"]);
  });
});

describe("non-finite numbers", () => {
  const paths = (tree: Parameters<typeof flattenTree>[0]) =>
    flattenTree(tree).map((issue) => `${issue.path.join(".")}: ${issue.kind}`);

  it("are accepted in attributes and other user data", () => {
    expect(paths(validateArrayMetadataV3({ ...VALID_ARRAY, attributes: { a: NaN }, "x.ext": { must_understand: false, v: Infinity } }))).toEqual([]);
    expect(
      paths(
        validateGroupMetadataV3({
          zarr_format: 3,
          node_type: "group",
          attributes: { a: -Infinity },
          consolidated_metadata: { kind: "inline", must_understand: false, metadata: { a: { fill_value: NaN } } },
        }),
      ),
    ).toEqual([]);
    expect(
      paths(
        validateConsolidatedMetadataV3({
          kind: "inline",
          must_understand: false,
          metadata: { a: { ...VALID_ARRAY, attributes: { a: NaN } } },
        }),
      ),
    ).toEqual([]);
    expect(
      paths(validateConsolidatedMetadataV2({ zarr_consolidated_format: 1, metadata: { ".zgroup": { zarr_format: 2 }, ".zattrs": { a: NaN } } })),
    ).toEqual([]);
  });

  it("are refused where the spec interprets a value", () => {
    expect(paths(validateArrayMetadataV3({ ...VALID_ARRAY, fill_value: NaN }))).toEqual(["fill_value: invalid_value"]);
    expect(
      paths(validateConsolidatedMetadataV3({ kind: "inline", must_understand: false, metadata: { a: { ...VALID_ARRAY, fill_value: NaN } } })),
    ).toEqual(["metadata.a.fill_value: invalid_value"]);
    expect(
      paths(
        validateArrayMetadataV2({
          zarr_format: 2, shape: [1], chunks: [1], dtype: "<f8", compressor: null, fill_value: null, order: "C", filters: null, extra: NaN,
        }),
      ),
    ).toEqual(["extra: invalid_value"]);
    expect(paths(validateConsolidatedMetadataV2({ zarr_consolidated_format: 1, metadata: { foo: Infinity } }))).toEqual([
      "metadata.foo: invalid_value",
    ]);
  });
});

describe("group ↔ consolidated recursion depth cap (round 2)", () => {
  function nestedGroups(depth: number): unknown {
    const open =
      '{"zarr_format":3,"node_type":"group","consolidated_metadata":{"kind":"inline","must_understand":false,"metadata":{"g":';
    return JSON.parse(
      open.repeat(depth) + '{"zarr_format":3,"node_type":"group"}' + "}}}".repeat(depth),
    );
  }

  it("reports a problem on a deep consolidated chain instead of throwing", async () => {
    const { validateGroupMetadataV3, validateMetadataV3 } = await import("../src/index.js");
    const deep = nestedGroups(5000);
    const problems = flattenTree(validateGroupMetadataV3(deep));
    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toContain("nesting depth");
    expect(flattenTree(validateMetadataV3(deep))).toHaveLength(1);
    // Shallow chains still validate cleanly.
    expect(flattenTree(validateGroupMetadataV3(nestedGroups(10)))).toEqual([]);
  });

  it("terminates on a circular consolidated graph", async () => {
    const { isGroupMetadataV3 } = await import("../src/index.js");
    const group: Record<string, unknown> = { zarr_format: 3, node_type: "group" };
    group["consolidated_metadata"] = {
      kind: "inline",
      must_understand: false,
      metadata: { self: group },
    };
    expect(isGroupMetadataV3(group)).toBe(false);
  });
});

describe("dense-array requirement (round 2)", () => {
  it("rejects arrays with an own toJSON so nothing validates as one thing and serializes as another", () => {
    const evil: number[] & { toJSON?: () => string } = [1, 2];
    evil.toJSON = () => "evil";
    expect(isJson(evil)).toBe(false);
    expect(() => dumpStoreJson(evil)).toThrow(MetadataValidationError);
  });

  it("rejects sparse arrays everywhere elements would be skipped", () => {
    // eslint-style hole: [1, <hole>, 3]
    const holey = [1, , 3]; // eslint-disable-line no-sparse-arrays
    expect(isJson(holey)).toBe(false);
    expect(flattenTree(validateArrayMetadataV2({
      zarr_format: 2,
      shape: holey,
      chunks: [1, 2, 3],
      dtype: "<f8",
      compressor: null,
      fill_value: 0,
      order: "C",
      filters: null,
    }))).toEqual([{ path: ["shape"], message: "expected an array of integers", kind: "invalid_type" }]);
    const problems = flattenTree(validateArrayMetadataV3({ ...VALID_ARRAY, dimension_names: [, "x"] })); // eslint-disable-line no-sparse-arrays
    expect(problems).toEqual([
      { path: ["dimension_names"], message: "expected an array", kind: "invalid_type" },
    ]);
  });
});
