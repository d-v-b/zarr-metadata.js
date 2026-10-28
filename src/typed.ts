/**
 * Typed JSON checking: parsers that check a JSON value against a declared
 * shape and locate every problem, as the reference implementation's
 * `zarr_metadata.typed_json.check` does for its TypedDicts. The semantic
 * layer declares each configuration and fill value with these, so a
 * problem lands at the same location, with the same kind, in both
 * implementations:
 *
 * - a value of the wrong JSON type is an `invalid_type`;
 * - a value of the right type outside a closed set, or past a bound, is an
 *   `invalid_value`;
 * - a missing required key is a `missing_key`, and a key that a closed
 *   object does not declare is an `unknown_key`, left out of the result.
 *
 * The input is JSON already (the structural layer reports anything else).
 */
import { append, type IssueKind, type IssuePath, type PathedIssue } from "./errors.js";

/** A checked value: the value as typed (closed objects lose undeclared keys), and every problem. */
export interface Parsed {
  readonly value: unknown;
  readonly issues: PathedIssue[];
}

/** Check `value`, found at `path`, against one declared shape. */
export type Parser = (value: unknown, path: IssuePath) => Parsed;

export function issue(path: IssuePath, message: string, kind: IssueKind = "invalid_type"): PathedIssue {
  return { path, message, kind };
}

/** Format a value for a message, as JSON. */
export function show(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "bigint") return value.toString();
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Set `key` on `target` as an own data property. Plain assignment would
 * treat a `"__proto__"` key, which `JSON.parse` makes an ordinary key, as
 * the object's prototype.
 */
export function defineOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

export function isObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
}

/** The JSON type of a value, as the kind of a problem compares types. */
function jsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function scalar(description: string, admits: (value: unknown) => boolean): Parser {
  return (value, path) =>
    admits(value)
      ? { value, issues: [] }
      : { value, issues: [issue(path, `expected ${description}, got ${show(value)}`)] };
}

/** A JSON integer. `true` is not the integer 1. */
export const integer: Parser = scalar("an integer", (value) => Number.isInteger(value));
/** A JSON number. */
export const number: Parser = scalar("a number", (value) => typeof value === "number");
export const boolean: Parser = scalar("a boolean", (value) => typeof value === "boolean");
export const string: Parser = scalar("a string", (value) => typeof value === "string");
/** Any JSON value. */
export const json: Parser = (value) => ({ value, issues: [] });

/**
 * The problem for `value` outside the closed set `allowed`: `invalid_type`
 * when no member of the set has its JSON type, else `invalid_value`.
 */
export function outsideOf(
  path: IssuePath,
  value: unknown,
  allowed: ReadonlyArray<string | number | boolean>,
): PathedIssue {
  const sameType = allowed.some((entry) => jsonType(entry) === jsonType(value));
  const expected = allowed.length === 1 ? show(allowed[0]) : `one of ${show([...allowed].sort())}`;
  return issue(path, `expected ${expected}, got ${show(value)}`, sameType ? "invalid_value" : "invalid_type");
}

/** One of a closed set of values (a `Literal`). */
export function oneOf(allowed: ReadonlyArray<string | number | boolean>): Parser {
  return (value, path) =>
    allowed.some((entry) => entry === value)
      ? { value, issues: [] }
      : { value, issues: [outsideOf(path, value, allowed)] };
}

/** An array of one element type, checked element by element. */
export function sequenceOf(element: Parser): Parser {
  return (value, path) => {
    if (!Array.isArray(value)) {
      return { value, issues: [issue(path, `expected an array, got ${show(value)}`)] };
    }
    const typed: unknown[] = [];
    const issues: PathedIssue[] = [];
    value.forEach((entry, index) => {
      const parsed = element(entry, [...path, index]);
      typed.push(parsed.value);
      append(issues, parsed.issues);
    });
    return { value: typed, issues };
  };
}

/** An array of a fixed length, checked position by position. */
export function fixedTuple(elements: ReadonlyArray<Parser>, description: string): Parser {
  return (value, path) => {
    if (!Array.isArray(value) || value.length !== elements.length) {
      return { value, issues: [issue(path, `expected ${description}, got ${show(value)}`)] };
    }
    const typed: unknown[] = [];
    const issues: PathedIssue[] = [];
    elements.forEach((element, position) => {
      const parsed = element(value[position], [...path, position]);
      typed.push(parsed.value);
      append(issues, parsed.issues);
    });
    return { value: typed, issues };
  };
}

/** The top-level JSON shape a union branch takes, used to choose the branches that try a value. */
export type Shape = "int" | "number" | "bool" | "str" | "null" | "tuple" | "mapping";

function hasShape(shape: Shape | undefined, value: unknown): boolean {
  switch (shape) {
    case undefined:
      return true;
    case "int":
      return Number.isInteger(value);
    case "number":
      return typeof value === "number";
    case "bool":
      return typeof value === "boolean";
    case "str":
      return typeof value === "string";
    case "null":
      return value === null;
    case "tuple":
      return Array.isArray(value);
    case "mapping":
      return isObject(value);
  }
}

export interface Branch {
  readonly shape: Shape | undefined;
  readonly parse: Parser;
  /** Whether the branch is a `Literal`, whose own check decides the kind of a lone miss. */
  readonly literal?: boolean;
}

/**
 * A union of shapes. Only the branches whose shape matches the value try
 * it, so a bad element inside an array is reported at its position. The
 * first branch with no problem wins; if every branch that tried reports
 * problems, the one with the fewest wins (the earliest on a tie). A value
 * that no branch's shape matches is reported once, as an `invalid_type`;
 * when only `Literal` branches tried it, it is reported once with the
 * kind their check decided.
 */
export function anyOf(branches: ReadonlyArray<Branch>, description: string): Parser {
  return (value, path) => {
    let best: { parsed: Parsed; literal: boolean } | undefined;
    let onlyLiterals = true;
    for (const branch of branches) {
      if (!hasShape(branch.shape, value)) continue;
      const parsed = branch.parse(value, path);
      if (parsed.issues.length === 0) return parsed;
      onlyLiterals &&= branch.literal === true;
      if (best === undefined || parsed.issues.length < best.parsed.issues.length) {
        best = { parsed, literal: branch.literal === true };
      }
    }
    const message = `expected ${description}, got ${show(value)}`;
    if (best === undefined) return { value, issues: [issue(path, message)] };
    if (onlyLiterals) {
      return { value, issues: [issue(path, message, (best.parsed.issues[0] as PathedIssue).kind)] };
    }
    return best.parsed;
  };
}

export interface Member {
  readonly parse: Parser;
  readonly required: boolean;
}

/**
 * An object with declared keys, each checked at its own key. A missing
 * required key is a `missing_key`. Without `extra` (a closed object), an
 * undeclared key is an `unknown_key` and is left out of the result.
 */
export function objectOf(members: Readonly<Record<string, Member>>, extra?: Parser): Parser {
  return (value, path) => {
    if (!isObject(value)) {
      return { value, issues: [issue(path, `expected an object, got ${show(value)}`)] };
    }
    const typed: Record<string, unknown> = {};
    const issues: PathedIssue[] = [];
    for (const [key, entry] of Object.entries(value)) {
      if (Object.hasOwn(members, key)) continue;
      if (extra === undefined) {
        issues.push(issue([...path, key], `unexpected key ${show(key)}`, "unknown_key"));
        continue;
      }
      const parsed = extra(entry, [...path, key]);
      defineOwn(typed, key, parsed.value);
      append(issues, parsed.issues);
    }
    for (const [key, member] of Object.entries(members)) {
      if (Object.hasOwn(value, key)) {
        const parsed = member.parse(value[key], [...path, key]);
        defineOwn(typed, key, parsed.value);
        append(issues, parsed.issues);
      } else if (member.required) {
        issues.push(issue([...path, key], `missing required key ${show(key)}`, "missing_key"));
      }
    }
    return { value: typed, issues };
  };
}

/** A required member. */
export function required(parse: Parser): Member {
  return { parse, required: true };
}

/** A member that may be left out. */
export function optional(parse: Parser): Member {
  return { parse, required: false };
}

/** An object with any keys, each value checked. */
export function mappingOf(entry: Parser): Parser {
  return (value, path) => {
    if (!isObject(value)) {
      return { value, issues: [issue(path, `expected an object, got ${show(value)}`)] };
    }
    const typed: Record<string, unknown> = {};
    const issues: PathedIssue[] = [];
    for (const [key, item] of Object.entries(value)) {
      const parsed = entry(item, [...path, key]);
      defineOwn(typed, key, parsed.value);
      append(issues, parsed.issues);
    }
    return { value: typed, issues };
  };
}

export interface Bounds {
  readonly ge?: number;
  readonly le?: number;
}

/**
 * `parse`, then the bounds its type carries: one `invalid_value` if any
 * bound fails. The bounds are checked only when `parse` reports nothing.
 */
export function constrained(parse: Parser, description: string, bounds: Bounds): Parser {
  const range =
    bounds.ge !== undefined && bounds.le !== undefined
      ? `in [${bounds.ge}, ${bounds.le}]`
      : bounds.ge !== undefined
        ? `>= ${bounds.ge}`
        : `<= ${bounds.le}`;
  return (value, path) => {
    const parsed = parse(value, path);
    if (parsed.issues.length > 0) return parsed;
    const held = parsed.value as number;
    if ((bounds.ge !== undefined && held < bounds.ge) || (bounds.le !== undefined && held > bounds.le)) {
      return {
        value: held,
        issues: [issue(path, `expected ${description} ${range}, got ${show(value)}`, "invalid_value")],
      };
    }
    return parsed;
  };
}

/** An integer in `[ge, le]` (either bound may be left out). */
export function integerIn(bounds: Bounds): Parser {
  return constrained(integer, "an integer", bounds);
}
