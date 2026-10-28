/**
 * The codecs this package interprets, one module per codec — the codecs of
 * the reference implementation's `CORE_AND_EXTENSIONS` scope. The pipeline
 * reader that threads chunks between them is in `pipeline.ts`.
 */
import type { CodecDefinition } from "../definition.js";
import { blosc } from "./blosc.js";
import { bytes } from "./bytes.js";
import { castValue } from "./cast-value.js";
import { crc32c } from "./crc32c.js";
import { gzip } from "./gzip.js";
import { scaleOffset } from "./scale-offset.js";
import { shardingIndexed } from "./sharding-indexed.js";
import { transpose } from "./transpose.js";
import { zstd } from "./zstd.js";

export type { BloscCodecConfiguration } from "./blosc.js";
export type { BytesCodecConfiguration } from "./bytes.js";
export type { CastValueCodecConfiguration, ScalarMapEntry } from "./cast-value.js";
export type { GzipCodecConfiguration } from "./gzip.js";
export type { ScaleOffsetCodecConfiguration } from "./scale-offset.js";
export type { ShardingIndexedCodecConfiguration } from "./sharding-indexed.js";
export type { TransposeCodecConfiguration } from "./transpose.js";
export type { ZstdCodecConfiguration } from "./zstd.js";

export const CODECS: readonly CodecDefinition[] = [
  blosc,
  bytes,
  castValue,
  crc32c,
  gzip,
  scaleOffset,
  shardingIndexed,
  transpose,
  zstd,
];
