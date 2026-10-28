import { RAW_BITS_NAME, type DataTypeDefinition } from "../definition.js";
import { issue, sequenceOf } from "../typed.js";
import { BYTE } from "./bytes.js";

/** Fill value of the `r<N>` raw-bits data types: one integer in `[0, 255]` per byte. */
export type RawBytesFillValue = number[];

/** The configuration a raw-bits name carries: its size in bits, `{bits: 16}` for `r16`. */
interface RawBitsConfiguration {
  bits: bigint;
}

/**
 * The core `r<N>` raw-bits data types, one definition filed under `r*`
 * that reads the size from the name. The size must be a positive multiple
 * of 8, and the fill value holds one byte value per 8 bits. Only `r8` has
 * a known storage (one byte); the spec says nothing yet about the byte
 * order of wider raw bits.
 */
export const raw: DataTypeDefinition<RawBitsConfiguration, number[]> = {
  name: RAW_BITS_NAME,
  // The configuration is carried by the name, never written in a document.
  configuration: (value) => ({ value, issues: [] }),
  requiresConfiguration: false,
  rules: ({ bits }) =>
    bits === 0n || bits % 8n !== 0n
      ? [issue(["bits"], `expected a size in bits that is a positive multiple of 8, got ${bits}`, "invalid_value")]
      : [],
  fillValue: sequenceOf(BYTE),
  fillValueRules: ({ bits }, _nested, value) => {
    const expected = bits / 8n;
    return BigInt(value.length) === expected
      ? []
      : [issue([], `expected ${expected} byte values, got ${value.length}`, "invalid_value")];
  },
  storage: ({ bits }) => (bits === 8n ? "single_byte" : undefined),
};
