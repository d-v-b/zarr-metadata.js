/**
 * Semantic-layer tests. This layer has no Python counterpart, so it is
 * covered here rather than by the conformance corpus.
 */
import { describe, expect, it } from "vitest";

import {
  decodeStoreJson,
  flattenTree,
  isEmptyTree,
  validateArraySemanticsV3,
  validateSemanticsV3,
} from "../src/index.js";

function array(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    zarr_format: 3,
    node_type: "array",
    shape: [12, 12],
    data_type: "float64",
    chunk_grid: { name: "regular", configuration: { chunk_shape: [6, 6] } },
    chunk_key_encoding: "default",
    fill_value: 0,
    codecs: ["bytes"],
    ...overrides,
  };
}

/** A failure label for a test document (JSON.stringify throws on bigints). */
function label(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "bigint" ? `${item}n` : item,
  );
}

function messages(value: unknown): string[] {
  return flattenTree(validateArraySemanticsV3(value)).map((issue) => issue.message);
}

describe("validateArraySemanticsV3", () => {
  it("accepts semantically consistent documents of every checked flavor", () => {
    const valid = [
      array({}),
      array({ data_type: "bool", fill_value: true }),
      array({ data_type: "uint8", fill_value: 255 }),
      // exact bigint bounds, and a rounded number at the bound (lenient)
      array({ data_type: "int64", fill_value: -9223372036854775808n }),
      array({ data_type: "uint64", fill_value: 18446744073709551615n }),
      array({ data_type: "int64", fill_value: 9223372036854775807 }),
      array({ data_type: "float64", fill_value: 100000000000000000000n }),
      array({ data_type: "float32", fill_value: "NaN" }),
      array({ data_type: "float64", fill_value: "0x7ff8000000000000" }),
      array({ data_type: "complex64", fill_value: [1.5, "Infinity"] }),
      array({ data_type: "my.custom.dtype", fill_value: { anything: true } }),
      array({
        codecs: [
          { name: "transpose", configuration: { order: [1, 0] } },
          {
            name: "sharding_indexed",
            configuration: {
              chunk_shape: [3, 3],
              codecs: [
                { name: "transpose", configuration: { order: [0, 1] } },
                "bytes",
              ],
              index_codecs: ["bytes", "crc32c"],
            },
          },
        ],
      }),
      // scalar arrays: everything is zero-dimensional and empty
      array({
        shape: [],
        chunk_grid: { name: "regular", configuration: { chunk_shape: [] } },
      }),
      // rectilinear: chunk sizes may overflow the dimension (e.g. after a
      // resize shrinks the array)
      array({
        chunk_grid: {
          name: "rectilinear",
          configuration: { kind: "inline", chunk_shapes: [[6, 12], [[4, 4]]] },
        },
      }),
      // rectilinear: bare-int shorthand (no sum rule), explicit lists and
      // RLE pairs summing exactly, and a sharding codec dividing every
      // distinct chunk size.
      array({
        chunk_grid: {
          name: "rectilinear",
          configuration: { kind: "inline", chunk_shapes: [6, [4, [2, 4]]] },
        },
        codecs: [
          {
            name: "sharding_indexed",
            configuration: { chunk_shape: [2, 2], codecs: ["bytes"], index_codecs: ["bytes"] },
          },
        ],
      }),
      // context threading: reshape may change the chunk's rank, so the
      // rank-4 transpose after it must not be judged by the array's rank
      // (the reshape spec explicitly endorses this combination)
      array({
        shape: [6, 6, 6],
        chunk_grid: { name: "regular", configuration: { chunk_shape: [6, 6, 6] } },
        codecs: [
          { name: "reshape", configuration: { shape: [[0], [1], 2, 3] } },
          { name: "transpose", configuration: { order: [3, 2, 1, 0] } },
          "bytes",
        ],
      }),
      // context threading: transpose permutes the chunk sizes the shard
      // must divide
      array({
        shape: [8, 12],
        chunk_grid: { name: "regular", configuration: { chunk_shape: [4, 6] } },
        codecs: [
          { name: "transpose", configuration: { order: [1, 0] } },
          {
            name: "sharding_indexed",
            configuration: { chunk_shape: [3, 4], codecs: ["bytes"], index_codecs: ["bytes"] },
          },
        ],
      }),
      // non-array documents and structural wrecks produce no semantic verdicts
      { zarr_format: 3, node_type: "group" },
      "not a document",
    ];
    for (const document of valid) {
      expect(isEmptyTree(validateArraySemanticsV3(document)), label(document)).toBe(true);
    }
  });

  it("rejects a chunk_shape arity mismatch with shape", () => {
    expect(
      messages(array({ chunk_grid: { name: "regular", configuration: { chunk_shape: [6] } } })),
    ).toEqual(["expected one length per dimension of shape (2)"]);
  });

  it("rejects a transpose order that is not a permutation", () => {
    expect(
      messages(array({ codecs: [{ name: "transpose", configuration: { order: [0, 2] } }, "bytes"] })),
    ).toEqual(["expected a permutation of the integers 0..1"]);
  });

  it("rejects a transpose order with the wrong dimensionality", () => {
    expect(
      messages(
        array({ codecs: [{ name: "transpose", configuration: { order: [0, 1, 2] } }, "bytes"] }),
      ),
    ).toEqual(["expected one entry per array dimension (2)"]);
  });

  it("rejects a sharding chunk_shape with the wrong dimensionality", () => {
    expect(
      messages(
        array({
          codecs: [
            {
              name: "sharding_indexed",
              configuration: { chunk_shape: [3], codecs: ["bytes"], index_codecs: ["bytes"] },
            },
          ],
        }),
      ),
    ).toEqual(["expected one length per array dimension (2)"]);
  });

  it("rejects a sharding chunk_shape that does not divide the outer chunk shape", () => {
    expect(
      messages(
        array({
          codecs: [
            {
              name: "sharding_indexed",
              configuration: { chunk_shape: [4, 3], codecs: ["bytes"], index_codecs: ["bytes"] },
            },
          ],
        }),
      ),
    ).toEqual(["expected [4,3] to evenly divide the outer chunk shape [6,6]"]);
  });

  it("rejects nested inner chunks that do not divide their parent shard's chunks", () => {
    expect(
      messages(
        array({
          codecs: [
            {
              name: "sharding_indexed",
              configuration: {
                chunk_shape: [6, 6],
                codecs: [
                  {
                    name: "sharding_indexed",
                    configuration: { chunk_shape: [4, 6], codecs: ["bytes"], index_codecs: ["bytes"] },
                  },
                ],
                index_codecs: ["bytes"],
              },
            },
          ],
        }),
      ),
    ).toEqual(["expected [4,6] to evenly divide the outer chunk shape [6,6]"]);
  });

  it("rejects a rectilinear chunk_shapes arity mismatch with shape", () => {
    expect(
      messages(
        array({
          chunk_grid: { name: "rectilinear", configuration: { kind: "inline", chunk_shapes: [12] } },
        }),
      ),
    ).toEqual(["expected one entry per dimension of shape (2)"]);
  });

  it("rejects explicit rectilinear chunk lists that fall short of the dimension length", () => {
    expect(
      messages(
        array({
          chunk_grid: {
            name: "rectilinear",
            configuration: { kind: "inline", chunk_shapes: [[4, [3, 2]], [5, 5]] },
          },
        }),
      ),
    ).toEqual([
      "expected chunk sizes summing to at least 12 along dimension 0, got 10",
      "expected chunk sizes summing to at least 12 along dimension 1, got 10",
    ]);
  });

  it("rejects a non-positive regular chunk size", () => {
    expect(
      messages(array({ chunk_grid: { name: "regular", configuration: { chunk_shape: [0, -6] } } })),
    ).toEqual(["expected a positive chunk size, got 0", "expected a positive chunk size, got -6"]);
  });

  it("rejects a sharding chunk_shape that does not divide every rectilinear chunk size", () => {
    expect(
      messages(
        array({
          chunk_grid: {
            name: "rectilinear",
            configuration: { kind: "inline", chunk_shapes: [[4, [2, 4]], 6] },
          },
          codecs: [
            {
              name: "sharding_indexed",
              configuration: { chunk_shape: [4, 3], codecs: ["bytes"], index_codecs: ["bytes"] },
            },
          ],
        }),
      ),
    ).toEqual([
      "expected [4,3] to evenly divide every chunk size of the grid (dimension 0 has chunk size 2)",
    ]);
  });

  it("rejects a shard sized for the un-permuted chunk after a transpose", () => {
    expect(
      messages(
        array({
          shape: [8, 12],
          chunk_grid: { name: "regular", configuration: { chunk_shape: [4, 6] } },
          codecs: [
            { name: "transpose", configuration: { order: [1, 0] } },
            {
              name: "sharding_indexed",
              configuration: { chunk_shape: [4, 6], codecs: ["bytes"], index_codecs: ["bytes"] },
            },
          ],
        }),
      ),
    ).toEqual(["expected [4,6] to evenly divide the outer chunk shape [6,4]"]);
  });

  it("makes no dimensional claims after an invalid transpose", () => {
    // The bad order is reported, but the sharding checks downstream of it
    // are suppressed: the chunk's true shape is unknowable from here.
    expect(
      messages(
        array({
          codecs: [
            { name: "transpose", configuration: { order: [0, 0] } },
            {
              name: "sharding_indexed",
              configuration: { chunk_shape: [5, 5], codecs: ["bytes"], index_codecs: ["bytes"] },
            },
          ],
        }),
      ),
    ).toEqual(["expected a permutation of the integers 0..1"]);
  });

  it("descends into inline consolidated entries, nested groups included", () => {
    const doc = {
      zarr_format: 3,
      node_type: "group",
      consolidated_metadata: {
        kind: "inline",
        must_understand: false,
        metadata: {
          bad_array: array({ data_type: "int32", fill_value: "NaN" }),
          nested_group: {
            zarr_format: 3,
            node_type: "group",
            consolidated_metadata: {
              kind: "inline",
              must_understand: false,
              metadata: { deeper: array({ data_type: "bool", fill_value: 0 }) },
            },
          },
        },
      },
    };
    // validateArraySemanticsV3 stays array-only...
    expect(isEmptyTree(validateArraySemanticsV3(doc))).toBe(true);
    // ...while validateSemanticsV3 paths each entry's issues through the envelope.
    expect(
      flattenTree(validateSemanticsV3(doc)).map((issue) => [issue.path.join("."), issue.message]),
    ).toEqual([
      [
        "consolidated_metadata.metadata.bad_array.fill_value",
        'expected an integer in [-2147483648, 2147483647] for data type "int32"',
      ],
      [
        "consolidated_metadata.metadata.nested_group.consolidated_metadata.metadata.deeper.fill_value",
        'expected a boolean fill value for data type "bool"',
      ],
    ]);
    // A plain array document goes through the same entry point unchanged.
    expect(isEmptyTree(validateSemanticsV3(array({})))).toBe(true);
  });

  it("rejects fill values that do not fit the core data type", () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ data_type: "bool", fill_value: 0 }, 'expected a boolean fill value for data type "bool"'],
      [
        { data_type: "uint8", fill_value: 300 },
        'expected an integer in [0, 255] for data type "uint8"',
      ],
      [
        { data_type: "int32", fill_value: 1.5 },
        'expected an integer in [-2147483648, 2147483647] for data type "int32"',
      ],
      [
        { data_type: "int64", fill_value: 9223372036854775808n },
        'expected an integer in [-9223372036854775808, 9223372036854775807] for data type "int64"',
      ],
      [
        { data_type: "int64", fill_value: -9223372036854775809n },
        'expected an integer in [-9223372036854775808, 9223372036854775807] for data type "int64"',
      ],
      [
        { data_type: "uint64", fill_value: 18446744073709551616n },
        'expected an integer in [0, 18446744073709551615] for data type "uint64"',
      ],
      [
        { data_type: "float32", fill_value: "0x7ff8000000000000" },
        'expected a number, "NaN", "Infinity", "-Infinity", or a 8-hex-digit "0x..." string for data type "float32"',
      ],
      [
        { data_type: "float64", fill_value: [] },
        'expected a number, "NaN", "Infinity", "-Infinity", or a 16-hex-digit "0x..." string for data type "float64"',
      ],
      [
        { data_type: "complex128", fill_value: [1] },
        'expected a two-element [real, imaginary] array for data type "complex128"',
      ],
    ];
    for (const [overrides, message] of cases) {
      expect(messages(array(overrides)), label(overrides)).toEqual([message]);
    }
  });

  it("rejects an out-of-range int64 fill decoded from JSON text", () => {
    // 2^63 and 2^63 - 1 are the same double: only exact decoding tells them apart.
    const text = JSON.stringify(array({ data_type: "int64", fill_value: "FILL" }));
    const decode = (fill: string) => decodeStoreJson(text.replace('"FILL"', fill));
    expect(messages(decode("9223372036854775807"))).toEqual([]);
    expect(messages(decode("9223372036854775808"))).toEqual([
      'expected an integer in [-9223372036854775808, 9223372036854775807] for data type "int64"',
    ]);
  });
});

describe("chunk grid configuration requirements", () => {
  it("requires a configuration for the regular grid", () => {
    expect(messages(array({ chunk_grid: "regular" }))).toEqual([
      '"regular" requires a configuration with "chunk_shape"',
    ]);
    expect(messages(array({ chunk_grid: { name: "regular" } }))).toEqual([
      '"regular" requires a configuration with "chunk_shape"',
    ]);
    expect(messages(array({ chunk_grid: { name: "regular", configuration: {} } }))).toEqual([
      "missing required key",
    ]);
  });

  it("requires kind and chunk_shapes for the rectilinear grid", () => {
    expect(messages(array({ chunk_grid: "rectilinear" }))).toEqual([
      '"rectilinear" requires a configuration with "kind" and "chunk_shapes"',
    ]);
    expect(
      messages(array({ chunk_grid: { name: "rectilinear", configuration: { kind: "inline" } } })),
    ).toEqual(["missing required key"]);
    expect(
      messages(
        array({ chunk_grid: { name: "rectilinear", configuration: { chunk_shapes: [12, 12] } } }),
      ),
    ).toEqual(["missing required key"]);
  });

  it("leaves a malformed configuration to the structural layer", () => {
    // configuration: 5 is present-but-wrong; the structural metadata-field
    // validator owns that complaint.
    expect(messages(array({ chunk_grid: { name: "regular", configuration: 5 } }))).toEqual([]);
  });
});

describe("codec configuration requirements", () => {
  it("requires order for transpose and the three sharding members", () => {
    expect(messages(array({ codecs: ["transpose", "bytes"] }))).toEqual([
      '"transpose" requires a configuration with "order"',
    ]);
    expect(messages(array({ codecs: [{ name: "transpose", configuration: {} }, "bytes"] }))).toEqual(
      ["missing required key"],
    );
    expect(messages(array({ codecs: ["sharding_indexed"] }))).toEqual([
      '"sharding_indexed" requires a configuration with "chunk_shape", "codecs", and "index_codecs"',
    ]);
    expect(
      messages(
        array({
          codecs: [{ name: "sharding_indexed", configuration: { chunk_shape: [6, 6] } }],
        }),
      ).sort(),
    ).toEqual(["missing required key", "missing required key"]);
  });

  it("still judges a present inner pipeline when sharding's chunk_shape is missing", () => {
    expect(
      messages(
        array({
          codecs: [
            {
              name: "sharding_indexed",
              configuration: {
                codecs: [{ name: "transpose", configuration: { order: [0, 0] } }, "bytes"],
                index_codecs: ["bytes"],
              },
            },
          ],
        }),
      ).sort(),
    ).toEqual(["expected a permutation of the integers 0..1", "missing required key"]);
  });

  it("leaves the uninterpreted codecs' required fields to the registry schemas", () => {
    // gzip/blosc/zstd requirements are registry-schema facts, not semantic
    // rules — a second hardcoded source of truth would drift.
    expect(messages(array({ codecs: ["bytes", "gzip"] }))).toEqual([]);
  });
});

describe("convention data types", () => {
  it("accepts valid fills across the convention types", () => {
    const structType = {
      name: "struct",
      configuration: {
        fields: [
          { name: "temperature", data_type: "float64" },
          { name: "flags", data_type: "uint8" },
          {
            name: "position",
            data_type: {
              name: "struct",
              configuration: { fields: [{ name: "x", data_type: "int32" }] },
            },
          },
        ],
      },
    };
    const valid = [
      array({ data_type: "string", fill_value: "missing" }),
      array({ data_type: "bytes", fill_value: [0, 255, 128] }),
      array({ data_type: "bytes", fill_value: "AQID" }),
      array({
        data_type: { name: "numpy.datetime64", configuration: { unit: "ns", scale_factor: 1 } },
        fill_value: "NaT",
      }),
      array({
        data_type: { name: "numpy.timedelta64", configuration: { unit: "s", scale_factor: 10 } },
        fill_value: -42,
      }),
      array({ data_type: "r16", fill_value: [0, 1] }),
      array({
        data_type: structType,
        fill_value: { temperature: "NaN", flags: 7, position: { x: 0 } },
      }),
    ];
    for (const document of valid) {
      expect(messages(document), JSON.stringify(document)).toEqual([]);
    }
  });

  it("rejects a non-string fill for string", () => {
    expect(messages(array({ data_type: "string", fill_value: 0 }))).toEqual([
      'expected a string fill value for data type "string"',
    ]);
  });

  it("rejects bytes fills that are neither byte arrays nor base64", () => {
    expect(messages(array({ data_type: "bytes", fill_value: [0, 256] }))).toEqual([
      'expected an array of integers in [0, 255] or a base64 string for data type "bytes"',
    ]);
    expect(messages(array({ data_type: "bytes", fill_value: "not base64!" }))).toEqual([
      'expected an array of integers in [0, 255] or a base64 string for data type "bytes"',
    ]);
  });

  it("requires unit and scale_factor for the numpy temporal types", () => {
    expect(messages(array({ data_type: "numpy.datetime64", fill_value: 0 }))).toEqual([
      '"numpy.datetime64" requires a configuration with "unit" and "scale_factor"',
    ]);
    expect(
      messages(
        array({
          data_type: { name: "numpy.timedelta64", configuration: { unit: "s" } },
          fill_value: 0,
        }),
      ),
    ).toEqual(["missing required key"]);
  });

  it("rejects a non-integer fill for the numpy temporal types", () => {
    expect(
      messages(
        array({
          data_type: { name: "numpy.datetime64", configuration: { unit: "ns", scale_factor: 1 } },
          fill_value: "2020-01-01",
        }),
      ),
    ).toEqual(['expected an integer or "NaT" for data type "numpy.datetime64"']);
  });

  it("rejects r<N> names that are not multiples of 8 and wrong-length fills", () => {
    expect(messages(array({ data_type: "r12", fill_value: [0] }))).toEqual([
      'expected "r<N>" with N a positive multiple of 8, got "r12"',
    ]);
    expect(messages(array({ data_type: "r16", fill_value: [0] }))).toEqual([
      'expected an array of 2 integers in [0, 255] for data type "r16"',
    ]);
  });

  it("requires fields for struct and judges its fill per field, recursively", () => {
    expect(messages(array({ data_type: "struct", fill_value: {} }))).toEqual([
      '"struct" requires a configuration with "fields"',
    ]);
    const structType = {
      name: "struct",
      configuration: {
        fields: [
          { name: "a", data_type: "int8" },
          {
            name: "b",
            data_type: {
              name: "struct",
              configuration: { fields: [{ name: "c", data_type: "bool" }] },
            },
          },
        ],
      },
    };
    expect(
      flattenTree(
        validateArraySemanticsV3(
          array({ data_type: structType, fill_value: { a: 300, b: { c: 1 }, extra: 0 } }),
        ),
      ).map((issue) => [issue.path.join("."), issue.message]),
    ).toEqual([
      ["fill_value.a", 'expected an integer in [-128, 127] for data type "int8"'],
      ["fill_value.b.c", 'expected a boolean fill value for data type "bool"'],
      ["fill_value.extra", "unexpected member (no such struct field)"],
    ]);
    expect(
      flattenTree(
        validateArraySemanticsV3(array({ data_type: structType, fill_value: { a: 1 } })),
      ).map((issue) => issue.path.join(".")),
    ).toEqual(["fill_value.b"]);
  });

  it("rejects a non-object fill for struct", () => {
    expect(
      messages(
        array({
          data_type: {
            name: "struct",
            configuration: { fields: [{ name: "a", data_type: "int8" }] },
          },
          fill_value: 5,
        }),
      ),
    ).toEqual(['expected an object mapping field names to fill values for data type "struct"']);
  });
});
