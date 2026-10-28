/**
 * Definitions: what this package knows about each extension name it
 * interprets, and how a metadata field is read through the definition that
 * claims its name. A port of the reference implementation's
 * `zarr_metadata.definition` layer.
 *
 * A definition holds the name, the shape of its configuration (a `Parser`
 * from `typed.ts`), and plain functions for the rules that shape cannot
 * express. Reading a field (`readField`) maps its name to a definition in a
 * `Scope`, checks the configuration, reads each metadata field nested in
 * it (a shard's codecs, a struct's field types) the same way, and then runs
 * the rules. The result is a `ResolvedField`:
 *
 * - `accepted`: claimed, and its configuration holds. Later rules (a fill
 *   value against its data type, a codec against the chunk it receives)
 *   read it.
 * - `refused`: claimed or malformed, with a problem. Nothing downstream
 *   reasons from it.
 * - `unclaimed`: no definition in scope claims the name. The extension
 *   name space is open, so this is not a problem, and nothing downstream
 *   reasons from it either.
 *
 * Only an `unknown_key` leaves a configuration usable: the key is reported
 * and left out, and the rules still run on the rest.
 */
import { append, type IssuePath, type PathedIssue } from "./errors.js";
import { flattenTree } from "./errors.js";
import { defineOwn, isObject, issue, objectOf, show, type Member, type Parser } from "./typed.js";
import { validateMetadataFieldV3 } from "./validation.js";

/** The kinds of v3 metadata field, each read from its own document member. */
export type FieldKind = "data_type" | "chunk_grid" | "chunk_key_encoding" | "codec";

/**
 * A metadata field found inside a configuration while checking it: where
 * it is, what kind of field the member holds, and its JSON. `staticOnly`
 * marks a member that admits only codecs of static size (a shard's
 * `index_codecs`).
 */
export class NestedField {
  constructor(
    readonly path: IssuePath,
    readonly kind: FieldKind,
    readonly json: unknown,
    readonly staticOnly: boolean,
  ) {}
}

/** A member holding a metadata field of `kind`, read through its own definition. */
export function field(kind: FieldKind, options: { staticOnly?: boolean } = {}): Parser {
  return (value, path) => ({
    value: new NestedField(path, kind, value, options.staticOnly ?? false),
    issues: [],
  });
}

/** The fields a configuration holds, as the scope read them, by location relative to the configuration. */
export type Nested = ReadonlyMap<string, ResolvedField>;

function nestedKey(path: IssuePath): string {
  return JSON.stringify(path);
}

/** The field read at `path` (relative to the configuration), if any. */
export function nestedAt(nested: Nested, ...path: Array<string | number>): ResolvedField | undefined {
  return nested.get(nestedKey(path));
}

const NO_NESTED: Nested = new Map();

/**
 * A closed configuration with `members`, and whether a document must write
 * it: it must when any member is required.
 */
export function configured(members: Readonly<Record<string, Member>>): {
  configuration: Parser;
  requiresConfiguration: boolean;
} {
  return {
    configuration: objectOf(members),
    requiresConfiguration: Object.values(members).some((member) => member.required),
  };
}

export interface Definition<C = any> {
  readonly name: string;
  /** The configuration's shape. */
  readonly configuration: Parser;
  /** Whether a document must write a configuration (it has a required key). */
  readonly requiresConfiguration: boolean;
  /** Problems the shape cannot express, located in the configuration. */
  readonly rules?: (configuration: C, nested: Nested) => PathedIssue[];
}

/** How a data type's values are stored, as a codec that writes them needs to know. */
export type StorageClass = "single_byte" | "multi_byte" | "variable_length";

export interface DataTypeDefinition<C = any, F = any> extends Definition<C> {
  /** The shape of a fill value. */
  readonly fillValue: Parser;
  /** Problems with a fill value of that shape, located in the fill value. */
  readonly fillValueRules?: (configuration: C, nested: Nested, value: F) => PathedIssue[];
  /** How the values are stored; undefined when unknown. */
  readonly storage?: (configuration: C, nested: Nested) => StorageClass | undefined;
}

/**
 * The lengths of a chunk along each axis: every length the chunks take
 * there, or undefined where unknown. Undefined as a whole when even the
 * number of axes is unknown.
 */
export type Lengths = ReadonlyArray<ReadonlyArray<number> | undefined>;

export interface ChunkGridDefinition<C = any> extends Definition<C> {
  /** Problems with this grid over an array of `shape`, located in the configuration. */
  readonly shapeRules?: (configuration: C, nested: Nested, shape: readonly number[]) => PathedIssue[];
  /** The chunk lengths along each axis of an array whose shape the grid fits. */
  readonly chunkLengths?: (configuration: C, nested: Nested, shape: readonly number[]) => Lengths;
}

export type ChunkKeyEncodingDefinition<C = any> = Definition<C>;

/** The input a codec receives: chunk lengths per axis and a data type, each undefined when unknown. */
export interface Chunk {
  readonly lengths: Lengths | undefined;
  readonly dataType: ResolvedField | undefined;
}

export const UNKNOWN_CHUNK: Chunk = { lengths: undefined, dataType: undefined };

/** What a codec converts its input to: the three positions a pipeline puts in order. */
export type CodecKind = "array_array" | "array_bytes" | "bytes_bytes";

export interface CodecDefinition<C = any> extends Definition<C> {
  readonly kind: CodecKind;
  /** Whether the size of the output is determined by the size of the input. */
  readonly size: "static" | "dynamic";
  /** Problems with this codec receiving `chunk`, located in the configuration. */
  readonly chunkRules?: (configuration: C, nested: Nested, chunk: Chunk) => PathedIssue[];
  /** The chunk an array -> array codec passes on; unknown when not declared. */
  readonly transition?: (configuration: C, nested: Nested, chunk: Chunk) => Chunk;
  /** The chunk each pipeline the codec holds receives, keyed by the configuration member holding it. */
  readonly pipelines?: (configuration: C, nested: Nested, chunk: Chunk) => Record<string, Chunk>;
}

export interface AcceptedField {
  readonly status: "accepted";
  readonly json: unknown;
  readonly name: string;
  readonly definition: Definition;
  readonly configuration: Record<string, unknown>;
  readonly nested: Nested;
}

export interface RefusedField {
  readonly status: "refused";
  readonly json: unknown;
  readonly name: string | undefined;
  readonly definition: Definition | undefined;
  readonly nested: Nested;
}

export interface UnclaimedField {
  readonly status: "unclaimed";
  readonly json: unknown;
  readonly name: string;
  readonly definition: undefined;
  readonly nested: Nested;
}

export type ResolvedField = AcceptedField | RefusedField | UnclaimedField;

/** The definitions each kind of field is read with, by the name each is filed under. */
export interface Scope {
  readonly data_type: ReadonlyMap<string, DataTypeDefinition>;
  readonly chunk_grid: ReadonlyMap<string, ChunkGridDefinition>;
  readonly chunk_key_encoding: ReadonlyMap<string, ChunkKeyEncodingDefinition>;
  readonly codec: ReadonlyMap<string, CodecDefinition>;
}

/** The name raw bits are filed under: `r16` reads as `r*` with `{"bits": 16}`. */
export const RAW_BITS_NAME = "r*";
const RAW_BITS = /^r([0-9]{1,100})$/;

/** The definition claiming `name` in `scope`, and the configuration the name itself carries. */
function claimant(
  scope: Scope,
  kind: FieldKind,
  name: string,
): { definition: Definition | undefined; carried: Record<string, unknown> | undefined } {
  if (kind === "data_type") {
    const raw = RAW_BITS.exec(name);
    if (raw !== null) {
      return { definition: scope.data_type.get(RAW_BITS_NAME), carried: { bits: BigInt(raw[1] as string) } };
    }
  }
  return { definition: scope[kind].get(name), carried: undefined };
}

/** A field's name and configuration: the name is undefined when the value is no field at all. */
function namedConfiguration(value: unknown): {
  name: string | undefined;
  given: Record<string, unknown> | undefined;
  malformed: boolean;
} {
  if (typeof value === "string") return { name: value, given: undefined, malformed: false };
  if (!isObject(value) || typeof value["name"] !== "string") {
    return { name: undefined, given: undefined, malformed: false };
  }
  if (!Object.hasOwn(value, "configuration")) return { name: value["name"], given: undefined, malformed: false };
  const configuration = value["configuration"];
  return isObject(configuration)
    ? { name: value["name"], given: configuration, malformed: false }
    : { name: value["name"], given: undefined, malformed: true };
}

/** Whether `name` may be used for a field: a valid extension name. */
function wellNamed(name: string): boolean {
  return flattenTree(validateMetadataFieldV3(name)).length === 0;
}

/** Whether only `unknown_key` problems were found, which leave a value usable. */
export function usable(issues: ReadonlyArray<PathedIssue>): boolean {
  return issues.every((found) => found.kind === "unknown_key");
}

export function prefixed(head: IssuePath, issues: ReadonlyArray<PathedIssue>): PathedIssue[] {
  return issues.map((found) => ({ ...found, path: [...head, ...found.path] }));
}

/** Every nested field the check left inside `value`, in order. */
function collect(value: unknown, into: NestedField[]): void {
  if (value instanceof NestedField) {
    into.push(value);
  } else if (Array.isArray(value)) {
    for (const entry of value) collect(entry, into);
  } else if (isObject(value)) {
    for (const entry of Object.values(value)) collect(entry, into);
  }
}

/** `value` with each nested field put back as written, without envelope members it does not declare. */
function putBack(value: unknown): unknown {
  if (value instanceof NestedField) {
    if (!isObject(value.json)) return value.json;
    const declared: Record<string, unknown> = {};
    for (const key of ["name", "configuration", "must_understand"]) {
      if (Object.hasOwn(value.json, key)) declared[key] = value.json[key];
    }
    return declared;
  }
  if (Array.isArray(value)) return value.map(putBack);
  if (isObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) defineOwn(out, key, putBack(entry));
    return out;
  }
  return value;
}

/** Whether a nested field has a name, and its configuration (if any) is an object. */
function named(nested: NestedField): boolean {
  const { name, malformed } = namedConfiguration(nested.json);
  return name !== undefined && !malformed;
}

/** The problems with a nested field's envelope, located at the field. */
function envelopeProblems(nested: NestedField): PathedIssue[] {
  return prefixed(
    nested.path,
    flattenTree(validateMetadataFieldV3(nested.json, { allowMustUnderstandFalse: false })),
  );
}

/** A dynamic-size codec in a member that admits only static-size codecs, located at the field. */
function sizeProblems(nested: NestedField, inner: ResolvedField): PathedIssue[] {
  const definition = inner.definition as CodecDefinition | undefined;
  if (!nested.staticOnly || definition === undefined || definition.size === "static") return [];
  return [
    issue(
      nested.path,
      `${show(definition.name)} is a codec of dynamic size, and only codecs of static size may be used here`,
      "invalid_value",
    ),
  ];
}

const EMPTY_CONFIGURATION: Parser = objectOf({});

/**
 * Read `data`, a metadata field of `kind` at `path`, in `scope`: map its
 * name to the definition that claims it, check its configuration, read the
 * fields nested in it, and run the rules. Returns the field as read and
 * every problem the read found. The envelope of `data` itself is not
 * checked here (the structural layer checks a document's fields; this
 * function checks the envelopes of the fields nested in a configuration).
 */
export function readField(
  data: unknown,
  kind: FieldKind,
  path: IssuePath,
  scope: Scope,
): { field: ResolvedField; issues: PathedIssue[] } {
  const refused = (definition?: Definition, nested: Nested = NO_NESTED, name?: string): RefusedField => ({
    status: "refused",
    json: data,
    name,
    definition,
    nested,
  });
  const { name, given, malformed } = namedConfiguration(data);
  if (name === undefined) return { field: refused(), issues: [] };
  // A name that is not a valid extension name is the envelope's problem,
  // and no definition is looked up for it.
  if (!wellNamed(name)) return { field: refused(undefined, NO_NESTED, name), issues: [] };
  const { definition, carried } = claimant(scope, kind, name);
  if (malformed) return { field: refused(definition, NO_NESTED, name), issues: [] };
  if (definition === undefined) {
    return { field: { status: "unclaimed", json: data, name, definition: undefined, nested: NO_NESTED }, issues: [] };
  }
  if (carried !== undefined) return readCarried(data, name, definition, given, carried, path);
  const at = [...path, "configuration"];
  if (given === undefined && definition.requiresConfiguration) {
    return {
      field: refused(definition, NO_NESTED, name),
      issues: [issue(at, `${show(name)} requires a configuration`, "missing_key")],
    };
  }
  const checked = definition.configuration(given ?? {}, at);
  const nestedFields: NestedField[] = [];
  collect(checked.value, nestedFields);
  const within = new Map<string, ResolvedField>();
  const inside: PathedIssue[] = [];
  for (const nested of nestedFields) {
    append(inside, envelopeProblems(nested));
    const inner = readField(nested.json, nested.kind, nested.path, scope);
    within.set(nestedKey(nested.path.slice(at.length)), inner.field);
    append(inside, inner.issues, sizeProblems(nested, inner.field));
  }
  // The rules may look a nested field up by its name, so they run only when
  // every nested field has one.
  const sound = usable(checked.issues) && nestedFields.every(named);
  const own = [...checked.issues];
  const configuration = sound ? (putBack(checked.value) as Record<string, unknown>) : undefined;
  if (configuration !== undefined && definition.rules !== undefined) {
    append(own, prefixed(at, definition.rules(configuration, within)));
  }
  if (configuration === undefined || !usable(own)) {
    return { field: refused(definition, within, name), issues: [...own, ...inside] };
  }
  return {
    field: { status: "accepted", json: data, name, definition, configuration, nested: within },
    issues: [...own, ...inside],
  };
}

/**
 * Read a field whose name carries its configuration (raw bits, `r16`). A
 * problem with the configuration in the name is a problem of the field,
 * located where the name is; a configuration written next to the name
 * must be empty.
 */
function readCarried(
  data: unknown,
  name: string,
  definition: Definition,
  given: Record<string, unknown> | undefined,
  carried: Record<string, unknown>,
  path: IssuePath,
): { field: ResolvedField; issues: PathedIssue[] } {
  const beside = EMPTY_CONFIGURATION(given ?? {}, [...path, "configuration"]).issues;
  const checked = definition.configuration(carried, []);
  const judged = [...checked.issues];
  if (judged.length === 0 && definition.rules !== undefined) {
    append(judged, definition.rules(checked.value, NO_NESTED));
  }
  const issues = [...beside, ...judged.map((found) => ({ ...found, path }))];
  if (!usable(beside) || judged.length > 0) {
    return { field: { status: "refused", json: data, name, definition, nested: NO_NESTED }, issues };
  }
  return {
    field: {
      status: "accepted",
      json: data,
      name,
      definition,
      configuration: checked.value as Record<string, unknown>,
      nested: NO_NESTED,
    },
    issues,
  };
}

/**
 * The problems with `value` as a fill value of `dataType` (a data type
 * field the scope read), located under `path`. A data type the scope did
 * not accept leaves its fill value unjudged.
 */
export function fillValueProblems(
  dataType: ResolvedField | undefined,
  value: unknown,
  path: IssuePath,
): PathedIssue[] {
  if (dataType?.status !== "accepted") return [];
  const definition = dataType.definition as DataTypeDefinition;
  const checked = definition.fillValue(value, path);
  if (!usable(checked.issues) || definition.fillValueRules === undefined) return checked.issues;
  return [
    ...checked.issues,
    ...prefixed(path, definition.fillValueRules(dataType.configuration, dataType.nested, checked.value)),
  ];
}

/** How the values of `dataType` are stored; undefined when the scope did not accept it, or its storage is unknown. */
export function storageOf(dataType: ResolvedField | undefined): StorageClass | undefined {
  if (dataType?.status !== "accepted") return undefined;
  const definition = dataType.definition as DataTypeDefinition;
  return definition.storage?.(dataType.configuration, dataType.nested);
}

/**
 * The chunk lengths of `grid` (a chunk grid field the scope read) along
 * each axis of an array of `shape`, and the problems with the grid for
 * that shape, located under `path`. Only an accepted grid that fits the
 * shape gives lengths.
 */
export function chunkGridLengths(
  grid: ResolvedField,
  shape: readonly number[],
  path: IssuePath,
): { lengths: Lengths; issues: PathedIssue[] } {
  const unknown: Lengths = shape.map(() => undefined);
  if (grid.status !== "accepted") return { lengths: unknown, issues: [] };
  const definition = grid.definition as ChunkGridDefinition;
  const issues = prefixed(
    [...path, "configuration"],
    definition.shapeRules?.(grid.configuration, grid.nested, shape) ?? [],
  );
  if (issues.length > 0) return { lengths: unknown, issues };
  return { lengths: definition.chunkLengths?.(grid.configuration, grid.nested, shape) ?? unknown, issues: [] };
}
