/** The chunk key encodings this package interprets: the two the core spec defines. */
import type { ChunkKeyEncodingDefinition } from "../definition.js";
import { defaultEncoding } from "./default.js";
import { v2Encoding } from "./v2.js";

export type { DefaultChunkKeyEncodingConfiguration } from "./default.js";
export type { V2ChunkKeyEncodingConfiguration } from "./v2.js";

export const CHUNK_KEY_ENCODINGS: readonly ChunkKeyEncodingDefinition[] = [defaultEncoding, v2Encoding];
