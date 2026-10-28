/**
 * The chunk grids this package interprets, one module per grid — the
 * grids of the reference implementation's `CORE_AND_EXTENSIONS` scope.
 */
import type { ChunkGridDefinition } from "../definition.js";
import { rectilinear } from "./rectilinear.js";
import { regular } from "./regular.js";

export type { RegularChunkGridConfiguration } from "./regular.js";
export type { RectilinearChunkGridConfiguration, RectilinearDimSpec } from "./rectilinear.js";

export const CHUNK_GRIDS: readonly ChunkGridDefinition[] = [regular, rectilinear];
