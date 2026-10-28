/**
 * Semantic-layer tests. The conformance corpus checks this layer against
 * the Python reference; these tests pin one case per rule here, by location
 * and kind, so a regression names the rule it broke.
 */
import { describe, expect, it } from "vitest";

import { flattenTree, validateArraySemanticsV3, validateSemanticsV3 } from "../src/index.js";

const LE = { name: "bytes", configuration: { endian: "little" } };

function array(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    zarr_format: 3,
    node_type: "array",
    shape: [12, 12],
    data_type: "float64",
    chunk_grid: { name: "regular", configuration: { chunk_shape: [6, 6] } },
    chunk_key_encoding: "default",
    fill_value: 0,
    codecs: [LE],
    ...overrides,
  };
}

function shard(configuration: Record<string, unknown>): Record<string, unknown> {
  return {
    name: "sharding_indexed",
    configuration: { chunk_shape: [3, 3], codecs: [LE], index_codecs: [LE, "crc32c"], ...configuration },
  };
}

/** The semantic problems of `value`, as sorted `path: kind` strings. */
function problems(value: unknown): string[] {
  return flattenTree(validateArraySemanticsV3(value))
    .map((issue) => `${issue.path.join(".")}: ${issue.kind}`)
    .sort();
}

describe("validateArraySemanticsV3", () => {
  it("accepts documents that every rule holds for", () => {
    const valid = [
      array(),
      array({ data_type: "bool", fill_value: true, codecs: ["bytes"] }),
      array({ data_type: "uint8", fill_value: 255, codecs: ["bytes"] }),
      array({ data_type: "int64", fill_value: -(2 ** 53) }),
      array({ data_type: "float32", fill_value: "NaN" }),
      array({ data_type: "float16", fill_value: "0x7e00" }),
      array({ data_type: "float64", fill_value: "0x7FF8000000000000" }),
      array({ data_type: "complex64", fill_value: [1.5, "Infinity"] }),
      array({ data_type: "r8", fill_value: [7], codecs: ["bytes"] }),
      // the spec says nothing yet about the byte order of wider raw bits
      array({ data_type: "r16", fill_value: [0, 255], codecs: ["bytes"] }),
      array({ data_type: "string", fill_value: "", codecs: [{ name: "vlen-utf8" }] }),
      array({ data_type: "bytes", fill_value: "QQ==", codecs: [{ name: "vlen-bytes" }] }),
      array({ data_type: "bytes", fill_value: [0, 255], codecs: [{ name: "vlen-bytes" }] }),
      array({
        data_type: { name: "numpy.datetime64", configuration: { unit: "ms", scale_factor: 10 } },
        fill_value: "NaT",
      }),
      array({
        data_type: { name: "numpy.timedelta64", configuration: { unit: "generic", scale_factor: 1 } },
        fill_value: -(2 ** 53),
      }),
      array({
        data_type: {
          name: "struct",
          configuration: {
            fields: [
              { name: "a", data_type: "uint8" },
              { name: "b", data_type: { name: "struct", configuration: { fields: [{ name: "c", data_type: "int8" }] } } },
            ],
          },
        },
        fill_value: { a: 1, b: { c: -1 } },
        // every field is a single byte, so no endian is needed
        codecs: ["bytes"],
      }),
      // an unclaimed data type leaves its fill value, and the bytes codec, unjudged
      array({ data_type: "my.custom.dtype", fill_value: { anything: true }, codecs: ["bytes"] }),
      array({ chunk_key_encoding: { name: "v2", configuration: { separator: "/" } } }),
      array({ chunk_key_encoding: { name: "my.encoding", configuration: { anything: 1 } } }),
      array({
        codecs: [
          { name: "transpose", configuration: { order: [1, 0] } },
          LE,
          { name: "blosc", configuration: { cname: "lz4", clevel: 5, shuffle: "noshuffle", blocksize: 0 } },
          { name: "zstd", configuration: { level: -5, checksum: true } },
          { name: "gzip", configuration: { level: 9 } },
          "crc32c",
        ],
      }),
      // a scalar array: zero dimensions, an empty chunk shape
      array({ shape: [], chunk_grid: { name: "regular", configuration: { chunk_shape: [] } } }),
      // a chunk larger than its dimension overhangs the edge
      array({ chunk_grid: { name: "regular", configuration: { chunk_shape: [100, 1] } } }),
      // rectilinear: a bare step, a run-length pair, and chunks past the edge
      array({
        chunk_grid: {
          name: "rectilinear",
          configuration: { kind: "inline", chunk_shapes: [6, [4, [2, 4], 6]] },
        },
        codecs: [shard({ chunk_shape: [2, 2] })],
      }),
      // a transpose permutes the chunk lengths a shard must divide
      array({
        shape: [8, 12],
        chunk_grid: { name: "regular", configuration: { chunk_shape: [4, 6] } },
        codecs: [{ name: "transpose", configuration: { order: [1, 0] } }, shard({ chunk_shape: [3, 4] })],
      }),
      // shards nest, each judged against the chunk its parent hands it
      array({ codecs: [shard({ codecs: [shard({ chunk_shape: [1, 3] })] })] }),
      // an unclaimed codec hands on a chunk with nothing known about it
      array({
        codecs: [
          { name: "reshape", configuration: { shape: [[0, 1]] } },
          { name: "transpose", configuration: { order: [2, 1, 0] } },
          "bytes",
        ],
      }),
      array({ codecs: [{ name: "mystery" }] }),
      array({
        data_type: "float32",
        fill_value: 0,
        codecs: [
          { name: "scale_offset", configuration: { offset: "NaN", scale: 2 } },
          {
            name: "cast_value",
            configuration: {
              data_type: "uint8",
              out_of_range: "wrap",
              scalar_map: { encode: [["NaN", 0]], decode: [[0, "Infinity"]] },
            },
          },
          // the cast hands on single bytes
          "bytes",
        ],
      }),
      "not a document",
    ];
    for (const document of valid) {
      expect(problems(document), JSON.stringify(document)).toEqual([]);
    }
  });

  it("rejects a fill value of the wrong JSON type for its data type", () => {
    expect(problems(array({ data_type: "int16", fill_value: "0" }))).toEqual(["fill_value: invalid_type"]);
  });

  it("rejects an integer fill value outside the data type's range", () => {
    expect(problems(array({ data_type: "int8", fill_value: 300 }))).toEqual(["fill_value: invalid_value"]);
  });

  it("rejects a float hex fill value of another width", () => {
    expect(problems(array({ data_type: "float32", fill_value: "0x7e00" }))).toEqual(["fill_value: invalid_value"]);
  });

  it("locates a complex fill value's problem at its component", () => {
    expect(problems(array({ data_type: "complex128", fill_value: [0, "0x7fc00000"] }))).toEqual([
      "fill_value.1: invalid_value",
    ]);
  });

  it("rejects a raw-bits size that is not a positive multiple of 8", () => {
    expect(problems(array({ data_type: "r12", fill_value: [0, 0] }))).toEqual(["data_type: invalid_value"]);
  });

  it("rejects a raw-bits fill value with the wrong number of bytes", () => {
    expect(problems(array({ data_type: "r16", fill_value: [0], codecs: ["bytes"] }))).toEqual([
      "fill_value: invalid_value",
    ]);
  });

  it("rejects a bytes fill value that is not base64", () => {
    expect(problems(array({ data_type: "bytes", fill_value: "AAA", codecs: [{ name: "vlen-bytes" }] }))).toEqual([
      "fill_value: invalid_value",
    ]);
  });

  it("requires a configuration for a data type that has required members", () => {
    expect(problems(array({ data_type: "numpy.datetime64", fill_value: 0 }))).toEqual([
      "data_type.configuration: missing_key",
    ]);
  });

  it("rejects a configuration member outside its closed set", () => {
    expect(
      problems(array({ data_type: { name: "numpy.datetime64", configuration: { unit: "fortnight", scale_factor: 1 } } })),
    ).toEqual(["data_type.configuration.unit: invalid_value"]);
  });

  it("reports a configuration key that the definition does not declare", () => {
    expect(problems(array({ data_type: { name: "float64", configuration: { x: 1 } } }))).toEqual([
      "data_type.configuration.x: unknown_key",
    ]);
  });

  it("judges a struct fill value field by field, recursively", () => {
    const data_type = {
      name: "struct",
      configuration: {
        fields: [
          { name: "a", data_type: "uint8" },
          { name: "b", data_type: { name: "struct", configuration: { fields: [{ name: "c", data_type: "int8" }] } } },
          { name: "d", data_type: "bool" },
        ],
      },
    };
    expect(problems(array({ data_type, fill_value: { a: 1, b: { c: 300 }, e: 0 }, codecs: ["bytes"] }))).toEqual([
      "fill_value.b.c: invalid_value",
      "fill_value.d: missing_key",
      "fill_value.e: unknown_key",
    ]);
  });

  it("rejects struct fields that are empty, unnamed, duplicated, or of variable size", () => {
    const fields = (value: unknown[]) => ({ name: "struct", configuration: { fields: value } });
    expect(problems(array({ data_type: fields([]), fill_value: {} }))).toEqual([
      "data_type.configuration.fields: invalid_value",
    ]);
    expect(
      problems(
        array({
          data_type: fields([
            { name: "", data_type: "int8" },
            { name: "a", data_type: "int8" },
            { name: "a", data_type: "int8" },
            { name: "s", data_type: "string" },
          ]),
          fill_value: {},
        }),
      ),
    ).toEqual([
      "data_type.configuration.fields.0.name: invalid_value",
      "data_type.configuration.fields.2.name: invalid_value",
      "data_type.configuration.fields.3.data_type: invalid_value",
    ]);
  });

  it("requires a configuration for the regular grid", () => {
    expect(problems(array({ chunk_grid: "regular" }))).toEqual(["chunk_grid.configuration: missing_key"]);
  });

  it("rejects a regular chunk length of 0, even over an empty dimension", () => {
    expect(
      problems(array({ shape: [0, 12], chunk_grid: { name: "regular", configuration: { chunk_shape: [0, 6] } } })),
    ).toEqual(["chunk_grid.configuration.chunk_shape.0: invalid_value"]);
  });

  it("rejects a regular chunk_shape with another number of dimensions than shape", () => {
    expect(problems(array({ chunk_grid: { name: "regular", configuration: { chunk_shape: [6] } } }))).toEqual([
      "chunk_grid.configuration.chunk_shape: invalid_value",
    ]);
  });

  it("rejects rectilinear chunk_shapes with another number of dimensions than shape", () => {
    expect(
      problems(array({ chunk_grid: { name: "rectilinear", configuration: { kind: "inline", chunk_shapes: [6] } } })),
    ).toEqual(["chunk_grid.configuration.chunk_shapes: invalid_value"]);
  });

  it("rejects rectilinear chunk lengths that do not cover their dimension", () => {
    expect(
      problems(
        array({ chunk_grid: { name: "rectilinear", configuration: { kind: "inline", chunk_shapes: [[6, 5], 6] } } }),
      ),
    ).toEqual(["chunk_grid.configuration.chunk_shapes.0: invalid_value"]);
  });

  it("rejects a rectilinear kind other than inline", () => {
    expect(
      problems(array({ chunk_grid: { name: "rectilinear", configuration: { kind: "file", chunk_shapes: [6, 6] } } })),
    ).toEqual(["chunk_grid.configuration.kind: invalid_value"]);
  });

  it("rejects a chunk key encoding separator outside its closed set", () => {
    expect(problems(array({ chunk_key_encoding: { name: "default", configuration: { separator: "-" } } }))).toEqual([
      "chunk_key_encoding.configuration.separator: invalid_value",
    ]);
  });

  it("requires a configuration for a codec that has required members", () => {
    expect(problems(array({ codecs: [LE, "gzip"] }))).toEqual(["codecs.1.configuration: missing_key"]);
  });

  it("rejects a codec configuration member out of its range", () => {
    expect(problems(array({ codecs: [LE, { name: "gzip", configuration: { level: 10 } }] }))).toEqual([
      "codecs.1.configuration.level: invalid_value",
    ]);
    expect(problems(array({ codecs: [LE, { name: "zstd", configuration: { level: 23 } }] }))).toEqual([
      "codecs.1.configuration.level: invalid_value",
    ]);
  });

  it("requires a blosc typesize unless shuffle is noshuffle", () => {
    expect(
      problems(array({ codecs: [LE, { name: "blosc", configuration: { cname: "lz4", clevel: 5, shuffle: "shuffle", blocksize: 0 } }] })),
    ).toEqual(["codecs.1.configuration.typesize: missing_key"]);
  });

  it("rejects a pipeline with no array -> bytes codec", () => {
    expect(problems(array({ codecs: [{ name: "gzip", configuration: { level: 1 } }] }))).toEqual(["codecs: invalid_value"]);
  });

  it("rejects a second array -> bytes codec", () => {
    expect(problems(array({ codecs: [LE, LE] }))).toEqual(["codecs.1: invalid_value"]);
  });

  it("rejects a codec out of pipeline order", () => {
    expect(problems(array({ codecs: [LE, { name: "transpose", configuration: { order: [1, 0] } }] }))).toEqual([
      "codecs.1: invalid_value",
    ]);
  });

  it("requires an endian for values of several bytes", () => {
    expect(problems(array({ codecs: ["bytes"] }))).toEqual(["codecs.0.configuration.endian: missing_key"]);
  });

  it("rejects the bytes codec for values that vary in size", () => {
    expect(problems(array({ data_type: "string", fill_value: "", codecs: ["bytes"] }))).toEqual([
      "codecs.0.configuration: invalid_value",
    ]);
  });

  it("rejects a transpose order that is not a permutation", () => {
    expect(problems(array({ codecs: [{ name: "transpose", configuration: { order: [0, 2] } }, LE] }))).toEqual([
      "codecs.0.configuration.order: invalid_value",
    ]);
  });

  it("rejects a transpose order with another number of axes than its chunk", () => {
    expect(problems(array({ codecs: [{ name: "transpose", configuration: { order: [2, 1, 0] } }, LE] }))).toEqual([
      "codecs.0.configuration.order: invalid_value",
    ]);
  });

  it("rejects a shard chunk_shape with another number of axes than the shard", () => {
    expect(problems(array({ codecs: [shard({ chunk_shape: [3] })] }))).toEqual([
      "codecs.0.configuration.chunk_shape: invalid_value",
    ]);
  });

  it("rejects an inner chunk length that does not divide the shard, along its axis", () => {
    expect(problems(array({ codecs: [shard({ chunk_shape: [3, 4] })] }))).toEqual([
      "codecs.0.configuration.chunk_shape.1: invalid_value",
    ]);
  });

  it("divides a transposed shard along its transposed axes", () => {
    expect(
      problems(
        array({
          shape: [8, 12],
          chunk_grid: { name: "regular", configuration: { chunk_shape: [4, 6] } },
          codecs: [{ name: "transpose", configuration: { order: [1, 0] } }, shard({ chunk_shape: [4, 3] })],
        }),
      ),
    ).toEqual(["codecs.1.configuration.chunk_shape.0: invalid_value", "codecs.1.configuration.chunk_shape.1: invalid_value"]);
  });

  it("rejects a codec of dynamic size in a shard's index codecs", () => {
    expect(
      problems(array({ codecs: [shard({ index_codecs: [LE, { name: "gzip", configuration: { level: 1 } }] })] })),
    ).toEqual(["codecs.0.configuration.index_codecs.1: invalid_value"]);
  });

  it("requires an endian for the shard index, which holds uint64 values", () => {
    expect(problems(array({ codecs: [shard({ index_codecs: ["bytes"] })] }))).toEqual([
      "codecs.0.configuration.index_codecs.0.configuration.endian: missing_key",
    ]);
  });

  it("rejects an empty inner pipeline in a shard", () => {
    expect(problems(array({ codecs: [shard({ codecs: [] })] }))).toEqual(["codecs.0.configuration.codecs: invalid_value"]);
  });

  it("checks the envelope of a codec nested in a configuration", () => {
    expect(problems(array({ codecs: [shard({ codecs: [{ ...LE, must_understand: false }] })] }))).toEqual([
      "codecs.0.configuration.codecs.0.must_understand: invalid_value",
    ]);
  });

  it("rejects a cast to a data type that models no real numbers", () => {
    expect(problems(array({ codecs: [{ name: "cast_value", configuration: { data_type: "complex64" } }, LE] }))).toEqual([
      "codecs.0.configuration.data_type: invalid_value",
    ]);
  });

  it("rejects wrapping to a floating-point data type", () => {
    expect(
      problems(array({ codecs: [{ name: "cast_value", configuration: { data_type: "float32", out_of_range: "wrap" } }, LE] })),
    ).toEqual(["codecs.0.configuration.out_of_range: invalid_value"]);
  });

  it("judges a cast's scalar map against the data type of each side", () => {
    const cast = (encode: unknown[]) =>
      array({ codecs: [{ name: "cast_value", configuration: { data_type: "uint8", scalar_map: { encode } } }, "bytes"] });
    // encode maps an input (float64) scalar to an output (uint8) scalar
    expect(problems(cast([[0, 300]]))).toEqual(["codecs.0.configuration.scalar_map.encode.0.1: invalid_value"]);
    expect(problems(cast([["x", 0]]))).toEqual(["codecs.0.configuration.scalar_map.encode.0.0: invalid_value"]);
  });

  it("rejects a cast of a chunk whose data type models no real numbers", () => {
    expect(
      problems(array({ data_type: "bool", fill_value: false, codecs: [{ name: "cast_value", configuration: { data_type: "uint8" } }, "bytes"] })),
    ).toEqual(["codecs.0.configuration: invalid_value"]);
  });

  it("rejects a null scale_offset scalar", () => {
    expect(problems(array({ codecs: [{ name: "scale_offset", configuration: { scale: null } }, LE] }))).toEqual([
      "codecs.0.configuration.scale: invalid_value",
    ]);
  });

  it("rejects scale_offset on a data type without arithmetic", () => {
    expect(
      problems(array({ data_type: "bool", fill_value: false, codecs: ["scale_offset", "bytes"] })),
    ).toEqual(["codecs.0.configuration: invalid_value"]);
  });

  it("judges scale_offset scalars as fill values of the input data type", () => {
    expect(problems(array({ data_type: "int8", codecs: [{ name: "scale_offset", configuration: { offset: 1.5 } }, "bytes"] }))).toEqual([
      "codecs.0.configuration.offset: invalid_type",
    ]);
  });

  it("makes no claim that depends on a shape with its own problem", () => {
    expect(problems(array({ shape: [12, -1], codecs: [shard({ chunk_shape: [5, 5] })] }))).toEqual([]);
  });
});

describe("validateSemanticsV3", () => {
  it("reads the documents a group's consolidated metadata lists, listed groups' own listings included", () => {
    const listing = (metadata: Record<string, unknown>) => ({ kind: "inline", must_understand: false, metadata });
    const group = {
      zarr_format: 3,
      node_type: "group",
      consolidated_metadata: listing({
        a: array({ data_type: "int8", fill_value: 300 }),
        g: { zarr_format: 3, node_type: "group", consolidated_metadata: listing({ b: array({ codecs: ["bytes"] }) }) },
      }),
    };
    const found = flattenTree(validateSemanticsV3(group)).map((issue) => `${issue.path.join(".")}: ${issue.kind}`);
    expect(found.sort()).toEqual([
      "consolidated_metadata.metadata.a.fill_value: invalid_value",
      "consolidated_metadata.metadata.g.consolidated_metadata.metadata.b.codecs.0.configuration.endian: missing_key",
    ]);
  });
});
