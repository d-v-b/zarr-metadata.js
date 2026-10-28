/**
 * Standard Schema conformance: the vendored types must match the official
 * `@standard-schema/spec`, and the schema objects must behave the way
 * standard-schema consumers (tRPC, form libraries) expect.
 */
import type { StandardSchemaV1 as OfficialV1 } from "@standard-schema/spec";
import { describe, expect, expectTypeOf, it } from "vitest";

import {
  arrayMetadataV2Schema,
  arrayMetadataV3Schema,
  metadataV3Schema,
  StandardSchemaV1,
  ZarrV3ArrayMetadataJSON,
  ZarrV3MetadataJSON,
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

describe("standard schema conformance", () => {
  it("the vendored types satisfy the official spec", () => {
    // Type-level: assignable in both directions between our vendored
    // interface and @standard-schema/spec.
    const official: OfficialV1<unknown, ZarrV3ArrayMetadataJSON> = arrayMetadataV3Schema;
    const vendored: StandardSchemaV1<unknown, ZarrV3ArrayMetadataJSON> = official;
    expect(vendored["~standard"].version).toBe(1);
    expect(vendored["~standard"].vendor).toBe("zarr-metadata");
  });

  it("InferOutput recovers the document type", () => {
    expectTypeOf<StandardSchemaV1.InferOutput<typeof metadataV3Schema>>().toEqualTypeOf<ZarrV3MetadataJSON>();
    expectTypeOf<StandardSchemaV1.InferInput<typeof metadataV3Schema>>().toEqualTypeOf<unknown>();
  });

  it("validates synchronously (a standard-schema consumer may await, but never must)", () => {
    const result = metadataV3Schema["~standard"].validate(VALID_ARRAY);
    expect(result).not.toBeInstanceOf(Promise);
  });

  it("success carries the narrowed value and no issues", async () => {
    const result = await arrayMetadataV3Schema["~standard"].validate(VALID_ARRAY);
    expect(result.issues).toBeUndefined();
    if (result.issues === undefined) {
      expect(result.value).toBe(VALID_ARRAY);
    }
  });

  it("failure carries pathed issues, with kind preserved as an extension", async () => {
    const result = await arrayMetadataV3Schema["~standard"].validate({
      ...VALID_ARRAY,
      codecs: [],
    });
    expect(result.issues).toEqual([
      {
        message: "expected an array -> bytes codec, got none",
        path: ["codecs"],
        kind: "invalid_value",
      },
    ]);
  });

  it("a root-level issue omits the path, per spec", async () => {
    const result = await arrayMetadataV2Schema["~standard"].validate(42);
    expect(result.issues).toEqual([{ message: "expected an object", kind: "invalid_type" }]);
  });
});
