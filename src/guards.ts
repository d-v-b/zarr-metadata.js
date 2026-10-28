/**
 * Shared value guards for the semantic layer. The structural document
 * layer (validation.ts) keeps its own copies deliberately: it is the
 * corpus-governed core and stays self-contained.
 */

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

export function isIntArray(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    Object.keys(value).length === value.length &&
    value.every((item) => Number.isInteger(item))
  );
}
