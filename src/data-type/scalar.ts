/**
 * The shared machinery of the core scalar data types: integers with their
 * ranges, IEEE 754 floats with their named and hex fill values, and complex
 * pairs of floats.
 */
import { configured, type DataTypeDefinition, type StorageClass } from "../definition.js";
import { anyOf, fixedTuple, integerIn, issue, number, show, string, type Parser } from "../typed.js";
import type { PathedIssue } from "../errors.js";

/** The configuration of a data type with nothing to configure: an empty, closed object. */
export const NOTHING_TO_CONFIGURE = configured({});

export const singleByte = (): StorageClass => "single_byte";
export const multiByte = (): StorageClass => "multi_byte";
export const variableLength = (): StorageClass => "variable_length";

/** A float fill value: a JSON number, a named non-finite value, or a hex string of the type's width. */
export type FloatFillValue = number | "NaN" | "Infinity" | "-Infinity" | string;

/** A complex fill value: `[real, imaginary]`, each a float fill value. */
export type ComplexFillValue = [FloatFillValue, FloatFillValue];

/** The named non-finite fill values every IEEE 754 type takes. */
export const FLOAT_SPECIAL_FILL_VALUES = ["NaN", "Infinity", "-Infinity"] as const;

/**
 * An integer data type, whose fill value is an integer in its range. The
 * 64-bit bounds are not exact as doubles (`2 ** 63 - 1` is `2 ** 63`),
 * which matches what `JSON.parse` makes of a fill value at the edge.
 */
export function intDataType(name: string, low: number, high: number, storage: () => StorageClass): DataTypeDefinition {
  return { name, ...NOTHING_TO_CONFIGURE, fillValue: integerIn({ ge: low, le: high }), storage };
}

const NUMBER_OR_STRING: Parser = anyOf(
  [
    { shape: "number", parse: number },
    { shape: "str", parse: string },
  ],
  "a number or a string",
);

/**
 * A float fill value of `name`, which is `hexDigits` hex digits wide: any
 * number (a reader rounds it), a named value, or `0x` and exactly
 * `hexDigits` hex digits, the bits of the value.
 */
function floatComponentProblems(name: string, hexDigits: number): (value: unknown) => PathedIssue[] {
  const hex = new RegExp(`^0x[0-9a-fA-F]{${hexDigits}}$`);
  return (value) => {
    if (typeof value !== "string" || (FLOAT_SPECIAL_FILL_VALUES as readonly string[]).includes(value)) return [];
    if (hex.test(value)) return [];
    return [
      issue(
        [],
        `expected a number, one of ${show([...FLOAT_SPECIAL_FILL_VALUES].sort())}, or a ${name} hex string, got ${show(value)}`,
        "invalid_value",
      ),
    ];
  };
}

/** A floating-point data type, `hexDigits` hex digits wide. */
export function floatDataType(name: string, hexDigits: number): DataTypeDefinition {
  return {
    name,
    ...NOTHING_TO_CONFIGURE,
    fillValue: NUMBER_OR_STRING,
    fillValueRules: (_configuration, _nested, value) => floatComponentProblems(name, hexDigits)(value),
    storage: multiByte,
  };
}

/** A complex data type whose components are floats of `componentName`, `hexDigits` hex digits wide. */
export function complexDataType(name: string, componentName: string, hexDigits: number): DataTypeDefinition {
  const component = floatComponentProblems(componentName, hexDigits);
  return {
    name,
    ...NOTHING_TO_CONFIGURE,
    fillValue: fixedTuple(
      [NUMBER_OR_STRING, NUMBER_OR_STRING],
      "a [a number or a string, a number or a string] pair",
    ),
    fillValueRules: (_configuration, _nested, value: unknown[]) =>
      value.flatMap((part, index) =>
        component(part).map((found) => ({ ...found, path: [index, ...found.path] })),
      ),
    storage: multiByte,
  };
}
