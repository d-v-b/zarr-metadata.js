/**
 * The error vocabulary: validation produces a tree of issues mirroring the
 * document's shape, and an empty tree means the document is valid.
 *
 * This shape is native to TypeScript validation libraries (compare Zod's
 * `treeifyError` and `safeParse`) rather than ported from the Python
 * reference implementation, which returns a flat list of loc-tagged
 * problems. The two are isomorphic: `flattenTree` produces the flat
 * path+kind form — the interchange format the cross-language conformance
 * corpus asserts on, and the form editor tooling needs to place a
 * diagnostic at a document location — and `treeOf` rebuilds a tree from it.
 *
 * Invariant: a subtree exists only on the path to at least one issue, so
 * `isEmptyTree` never has to search — an empty root IS the success case.
 */

/**
 * Machine-readable classification of an issue.
 *
 * - `missing_key`: a required key (document key or store key) is absent.
 * - `invalid_type`: a value has the wrong structural type (e.g. a string
 *   where a mapping is required).
 * - `invalid_value`: a value has an acceptable type but invalid content
 *   (e.g. `zarr_format: 2` in a v3 document, `order: "Q"`).
 * - `invalid_json`: bytes/text that do not decode as JSON.
 * - `unknown_key`: a key that a closed object does not declare (an extra
 *   member of a metadata field envelope, of a `.zgroup`, or of a
 *   configuration the semantic layer interprets). It has its own kind
 *   because whether a configuration is closed is rarely stated by the
 *   spec, and a consumer may choose to tolerate such keys.
 */
export type IssueKind =
  | "missing_key"
  | "invalid_type"
  | "invalid_value"
  | "invalid_json"
  | "unknown_key";

/** One problem, attached to the tree node whose document location it describes. */
export interface Issue {
  readonly kind: IssueKind;
  readonly message: string;
}

/**
 * The path from the document root to a value: object keys and array
 * indices, e.g. `["codecs", 0, "name"]`. Empty means the document itself.
 */
export type IssuePath = ReadonlyArray<string | number>;

/** An issue paired with its full path — the flat view of a tree entry. */
export interface PathedIssue extends Issue {
  readonly path: IssuePath;
}

/**
 * Every problem found in a document, arranged as a tree mirroring the
 * document's own shape: `issues` holds the problems at this location, and
 * `children` (keyed by object key or array index) holds the problems below
 * it. An empty tree — no issues, no children — means validation succeeded.
 *
 * `children` is a `Map` so array indices keep their number identity
 * instead of collapsing into string keys.
 */
export interface ErrorTree {
  readonly issues: ReadonlyArray<Issue>;
  readonly children: ReadonlyMap<string | number, ErrorTree>;
}

/** Whether `tree` holds no issues anywhere — the success verdict. */
export function isEmptyTree(tree: ErrorTree): boolean {
  return tree.issues.length === 0 && tree.children.size === 0;
}

interface MutableTree {
  issues: Issue[];
  children: Map<string | number, MutableTree>;
}

/** Build an `ErrorTree` from flat pathed issues (the inverse of `flattenTree`). */
export function treeOf(issues: ReadonlyArray<PathedIssue>): ErrorTree {
  const root: MutableTree = { issues: [], children: new Map() };
  for (const { path, kind, message } of issues) {
    let node = root;
    for (const part of path) {
      let child = node.children.get(part);
      if (child === undefined) {
        child = { issues: [], children: new Map() };
        node.children.set(part, child);
      }
      node = child;
    }
    node.issues.push({ kind, message });
  }
  return root;
}

/**
 * The flat view of `tree`: every issue with its full path, parents before
 * children. This is the interchange form — what the conformance corpus
 * asserts on, and what a consumer placing diagnostics in a text document
 * wants.
 */
export function flattenTree(tree: ErrorTree): PathedIssue[] {
  const out: PathedIssue[] = [];
  const walk = (node: ErrorTree, path: IssuePath): void => {
    for (const issue of node.issues) {
      out.push({ path, kind: issue.kind, message: issue.message });
    }
    for (const [part, child] of node.children) {
      walk(child, [...path, part]);
    }
  };
  walk(tree, []);
  return out;
}

function formatPathedIssue(issue: PathedIssue): string {
  const location = issue.path.length > 0 ? issue.path.join(".") : "<root>";
  return `${location}: ${issue.message}`;
}

/** Render `tree` as one human-readable line per issue (`"path.to.value: message"`). */
export function formatTree(tree: ErrorTree): string {
  return flattenTree(tree).map(formatPathedIssue).join("\n");
}

/**
 * The result of a `safeParse*` function: the narrowed document on success,
 * the error tree on failure.
 */
export type ParseResult<T> =
  | { readonly success: true; readonly value: T }
  | { readonly success: false; readonly errors: ErrorTree };

/**
 * Thrown by `parse*` functions and the store entry points when a value
 * fails validation. Carries the complete error tree (not just the first
 * problem) as `.errors`, with `.issues` as its flat view.
 */
export class MetadataValidationError extends Error {
  readonly errors: ErrorTree;
  readonly issues: ReadonlyArray<PathedIssue>;

  constructor(errors: ErrorTree) {
    const issues = flattenTree(errors);
    super(issues.map(formatPathedIssue).join("\n"));
    this.name = "MetadataValidationError";
    this.errors = errors;
    this.issues = issues;
  }
}
