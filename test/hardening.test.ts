/**
 * Tests for behavior the conformance corpus cannot express because its
 * fixtures must be JSON text: hostile runtime values (depth bombs, cycles,
 * BigInt, non-plain objects) and the byte-level store entry points.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

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
  validateArraySemanticsV3,
  validateConsolidatedMetadataV2,
  validateConsolidatedMetadataV3,
  validateGroupMetadataV3,
  validateJson,
  validateMetadataV3,
  validateSemanticsV3,
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

  it("reads a NaN value under a key named NaN", () => {
    expect(loadStoreJson({ key: '{"NaN": NaN}' }, "key")).toEqual({ NaN: NaN });
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

  it("reads a large document holding a NaN", () => {
    const data = Array.from({ length: 200_000 }, (_, index) => index);
    const text = JSON.stringify({ data, attributes: { x: 0 } }, null, 2).replace('"x": 0', '"x": NaN');
    const value = loadStoreJson({ key: text }, "key") as { data: number[]; attributes: { x: number } };
    expect(value.data).toHaveLength(200_000);
    expect(value.attributes.x).toBeNaN();
  });

  it("reports malformed JSON, invalid UTF-8, and misplaced constants as invalid_json", () => {
    const malformed = [
      "{",
      new Uint8Array([0xff, 0xfe]),
      "[1 NaN]",
      "NaNa",
      "nan",
      "{NaN: 1}",
      '{"a": {Infinity: []}}',
    ];
    for (const raw of malformed) {
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

  describe("when the document already holds the marker the first draw would give", () => {
    // The token markers carry a nonce drawn from Math.random; forcing the
    // first draw makes the document collide with it, so only a nonce chosen
    // against the document's own text keeps the document as written.
    const first = 0.123456789;
    const marker = `\u0000zarr-metadata-${first.toString(36).slice(2)}-NaN`;
    const forceDraws = () => vi.spyOn(Math, "random").mockReturnValueOnce(first).mockReturnValueOnce(0.987654321);
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("writes the string as written", () => {
      const draws = forceDraws();
      const document = { attributes: { a: NaN, note: marker } };
      const text = new TextDecoder().decode(dumpStoreJson(document, { allowNonFinite: true }));
      // A second draw happens only when the first collided, so this also
      // confirms the planted marker still matches the first draw's.
      expect(draws).toHaveBeenCalledTimes(2);
      expect(text).toContain('"a":NaN');
      expect(JSON.parse(text.replace("NaN", "null"))).toEqual({ attributes: { a: null, note: marker } });
    });

    it("reads the string as written, as a key", () => {
      const draws = forceDraws();
      const text = `{${JSON.stringify(marker)}: 1, "a": NaN}`;
      expect(loadStoreJson({ k: text }, "k")).toEqual({ [marker]: 1, a: NaN });
      expect(draws).toHaveBeenCalledTimes(2);
    });
  });

  it("writes non-finite numbers as bare tokens when asked, and reads them back", () => {
    const document = { ...VALID_ARRAY, attributes: { _FillValue: NaN, range: [-Infinity, Infinity] } };
    const bytes = dumpStoreJson(document, { allowNonFinite: true });
    expect(new TextDecoder().decode(bytes)).toContain('"_FillValue":NaN,"range":[-Infinity,Infinity]');
    expect(loadStoreJson({ "zarr.json": bytes }, "zarr.json")).toEqual(document);
    expect(() => dumpStoreJson(new Map(), { allowNonFinite: true })).toThrow(MetadataValidationError);
  });
});

describe("validateGroupMetadataV3", () => {
  it("still checks the documents a group lists as user data", () => {
    const listed = { ...VALID_ARRAY, attributes: { a: new Map() } };
    const problems = flattenTree(
      validateGroupMetadataV3({
        zarr_format: 3,
        node_type: "group",
        consolidated_metadata: { kind: "inline", must_understand: false, metadata: { a: listed, b: { node_type: "x", c: new Set() } } },
      }),
    ).map((issue) => `${issue.path.join(".")}: ${issue.kind}`);
    expect(problems.sort()).toEqual([
      "consolidated_metadata.metadata.a.attributes.a: invalid_type",
      "consolidated_metadata.metadata.b.c: invalid_type",
    ]);
  });
});

describe("two listings of one group", () => {
  const group = (attributes: Record<string, unknown>) => ({ zarr_format: 3, node_type: "group", attributes });
  const listing = (metadata: Record<string, unknown>) => ({ kind: "inline", must_understand: false, metadata });
  /** The problems of a listing where the group `g` lists `x` as `nested`, and the outer listing lists it as `flat`. */
  const compared = (nested: unknown, flat: unknown) =>
    flattenTree(
      validateConsolidatedMetadataV3(
        listing({ g: { zarr_format: 3, node_type: "group", consolidated_metadata: listing({ x: nested }) }, "g/x": flat }),
      ),
    ).map((issue) => `${issue.path.join(".")}: ${issue.kind}`);
  const proto = (value: number) => JSON.parse(`{"zarr_format": 3, "node_type": "group", "__proto__": ${value}}`) as unknown;

  it("read alike when written alike, non-finite numbers and __proto__ members included", () => {
    for (const value of [NaN, Infinity, -Infinity, null, 1]) {
      expect(compared(group({ a: value }), group({ a: value })), String(value)).toEqual([]);
    }
    expect(compared(proto(1), proto(1))).toEqual([]);
  });

  it("differ when an attribute or an extra member is written otherwise", () => {
    const pairs: Array<[unknown, unknown]> = [
      [group({ a: NaN }), group({ a: null })],
      [group({ a: Infinity }), group({ a: -Infinity })],
      [group({ a: Infinity }), group({ a: null })],
      [proto(1), proto(2)],
    ];
    for (const [nested, flat] of pairs) {
      expect(compared(nested, flat)).toEqual(["metadata.g.consolidated_metadata.metadata.x: invalid_value"]);
    }
  });
});

describe("validateConsolidatedMetadataV3", () => {
  it("checks a listed document that is no node as user data", () => {
    const problems = flattenTree(
      validateConsolidatedMetadataV3({ kind: "inline", must_understand: false, metadata: { b: { node_type: "x", c: new Set() } } }),
    ).map((issue) => `${issue.path.join(".")}: ${issue.kind}`);
    expect(problems.sort()).toEqual([
      "metadata.b.c: invalid_type",
      "metadata.b.node_type: invalid_value",
      "metadata.b.zarr_format: missing_key",
    ]);
  });
});

describe("a \"__proto__\" key", () => {
  it("is read as an ordinary key, as JSON.parse reads it", () => {
    const struct = {
      name: "struct",
      configuration: { fields: [{ name: "__proto__", data_type: "int8" }] },
    };
    const doc = (fill: string) => JSON.parse(
      `{"zarr_format":3,"node_type":"array","shape":[4],"data_type":${JSON.stringify(struct)},` +
        `"chunk_grid":{"name":"regular","configuration":{"chunk_shape":[2]}},` +
        `"chunk_key_encoding":"default","fill_value":${fill},"codecs":["bytes"]}`,
    ) as unknown;
    const problems = (fill: string) =>
      flattenTree(validateArraySemanticsV3(doc(fill))).map((issue) => `${issue.path.join(".")}: ${issue.kind}`);
    expect(problems('{"__proto__": 0}')).toEqual([]);
    expect(problems('{"__proto__": 0, "x": 1}')).toEqual(["fill_value.x: unknown_key"]);
    expect(problems("{}")).toEqual(["fill_value.__proto__: missing_key"]);
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

describe("validateMetadataV3 on a group, for a listed document that is no node", () => {
  it("checks it once, as user data", () => {
    const problems = flattenTree(
      validateMetadataV3({
        zarr_format: 3,
        node_type: "group",
        consolidated_metadata: { kind: "inline", must_understand: false, metadata: { b: { node_type: "x", c: new Set() } } },
      }),
    ).map((issue) => `${issue.path.join(".")}: ${issue.kind}`);
    expect(problems.sort()).toEqual([
      "consolidated_metadata.metadata.b.c: invalid_type",
      "consolidated_metadata.metadata.b.node_type: invalid_value",
      "consolidated_metadata.metadata.b.zarr_format: missing_key",
    ]);
  });
});

describe("problem lists as long as the document", () => {
  it("are returned, not thrown, for a large array of non-finite numbers", () => {
    const many = Array.from({ length: 200_000 }, () => NaN);
    expect(isJson(many)).toBe(false);
    expect(flattenTree(validateArrayMetadataV3({ ...VALID_ARRAY, fill_value: many }))).toHaveLength(200_000);
    const grid = { name: "rectilinear", configuration: { kind: "inline", chunk_shapes: [Array.from({ length: 200_000 }, () => 0)] } };
    const codecs = [{ name: "bytes", configuration: { endian: "little" } }];
    expect(flattenTree(validateArraySemanticsV3({ ...VALID_ARRAY, chunk_grid: grid, codecs }))).toHaveLength(200_000);
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

  it("stops both layers at the same nested listing, wherever the depth cap falls", () => {
    // A chain of listed groups, each listing the next, with an array that
    // breaks a semantic rule in the deepest listing. Each listed group's own
    // check walks the listings below it as JSON, so a long enough chain
    // meets the depth cap inside the first listed group's listing; neither
    // layer then reads further. The planted problem must be judged exactly
    // when no depth problem is reported, whatever MAX_JSON_DEPTH is.
    const listing = (metadata: Record<string, unknown>) => ({ kind: "inline", must_understand: false, metadata });
    const planted = {
      zarr_format: 3,
      node_type: "array",
      shape: [4],
      data_type: "int8",
      chunk_grid: { name: "regular", configuration: { chunk_shape: [2] } },
      chunk_key_encoding: "default",
      fill_value: 300,
      codecs: ["bytes"],
    };
    const chain = (levels: number) => {
      let metadata: Record<string, unknown> = { a: planted };
      for (let level = 0; level < levels; level++) {
        metadata = { g: { zarr_format: 3, node_type: "group", consolidated_metadata: listing(metadata) } };
      }
      return { zarr_format: 3, node_type: "group", consolidated_metadata: listing(metadata) };
    };
    const inFirstListing = ["consolidated_metadata", "metadata", "g", "consolidated_metadata", "metadata"];
    const seen = new Set<boolean>();
    for (let levels = 1; levels <= MAX_JSON_DEPTH / 2; levels++) {
      const depth = flattenTree(validateMetadataV3(chain(levels))).filter((issue) =>
        issue.message.includes("nesting depth"),
      );
      for (const issue of depth) expect(issue.path.slice(0, inFirstListing.length)).toEqual(inFirstListing);
      const plantedAt = [
        "consolidated_metadata",
        ...Array.from({ length: levels }, () => ["metadata", "g", "consolidated_metadata"]).flat(),
        "metadata",
        "a",
        "fill_value",
      ];
      const judged = flattenTree(validateSemanticsV3(chain(levels))).some(
        (issue) => issue.kind === "invalid_value" && JSON.stringify(issue.path) === JSON.stringify(plantedAt),
      );
      expect(judged, `${levels} levels`).toBe(depth.length === 0);
      seen.add(judged);
    }
    // The range crosses the cap, so both outcomes were checked.
    expect([...seen].sort()).toEqual([false, true]);
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
