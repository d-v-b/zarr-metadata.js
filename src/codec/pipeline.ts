/**
 * Reading a codec pipeline: each codec judged against the chunk it
 * receives. A pipeline is array -> array codecs, then exactly one
 * array -> bytes codec, then bytes -> bytes codecs. The first codec
 * receives the grid's chunks, of the array's data type; each array -> array
 * codec passes the next the chunk its `transition` gives. A codec that
 * holds pipelines of its own (a shard) has each read the same way, from
 * the chunk its `pipelines` gives.
 *
 * Nothing is guessed: after a codec that was not accepted (no definition
 * claims it, or its configuration has a problem), or one that does not
 * declare its output, the next codec receives a chunk with nothing known
 * about it. An unclaimed codec could be of any kind, so the order check
 * skips it.
 */
import {
  nestedAt,
  prefixed,
  UNKNOWN_CHUNK,
  type Chunk,
  type CodecDefinition,
  type CodecKind,
  type ResolvedField,
} from "../definition.js";
import type { IssuePath, PathedIssue } from "../errors.js";
import { issue, show } from "../typed.js";

const POSITIONS: Record<CodecKind, number> = { array_array: 0, array_bytes: 1, bytes_bytes: 2 };
const SPOKEN: Record<CodecKind, string> = {
  array_array: "array -> array",
  array_bytes: "array -> bytes",
  bytes_bytes: "bytes -> bytes",
};

function orderProblems(codecs: ReadonlyArray<ResolvedField>, path: IssuePath): PathedIssue[] {
  const issues: PathedIssue[] = [];
  let furthest: CodecDefinition | undefined;
  let encoder: CodecDefinition | undefined;
  let unclaimed = false;
  codecs.forEach((codec, index) => {
    const definition = codec.definition as CodecDefinition | undefined;
    if (definition === undefined) {
      unclaimed = true;
      return;
    }
    if (furthest !== undefined && POSITIONS[definition.kind] < POSITIONS[furthest.kind]) {
      issues.push(
        issue(
          [...path, index],
          `expected ${SPOKEN[definition.kind]} codecs before ${SPOKEN[furthest.kind]} codecs, ` +
            `got ${show(definition.name)} after ${show(furthest.name)}`,
          "invalid_value",
        ),
      );
    } else if (definition.kind === "array_bytes" && encoder !== undefined) {
      issues.push(
        issue(
          [...path, index],
          `expected one array -> bytes codec, got ${show(definition.name)} after ${show(encoder.name)}`,
          "invalid_value",
        ),
      );
    }
    if (furthest === undefined || POSITIONS[definition.kind] > POSITIONS[furthest.kind]) furthest = definition;
    if (definition.kind === "array_bytes" && encoder === undefined) encoder = definition;
  });
  if (encoder === undefined && !unclaimed) {
    issues.push(issue(path, "expected an array -> bytes codec, got none", "invalid_value"));
  }
  return issues;
}

/**
 * Every problem in `codecs` (codec fields the scope read, located at
 * `path`) read as a pipeline receiving `chunk`. With `checkEmpty` false,
 * an empty pipeline is not reported (the structural layer reports an
 * empty `codecs` member).
 */
export function pipelineProblems(
  codecs: ReadonlyArray<ResolvedField>,
  chunk: Chunk,
  path: IssuePath,
  options: { checkEmpty: boolean },
): PathedIssue[] {
  const issues = codecs.length === 0 && !options.checkEmpty ? [] : orderProblems(codecs, path);
  let handed: Chunk | undefined = chunk;
  codecs.forEach((codec, index) => {
    const definition = codec.definition as CodecDefinition | undefined;
    if (definition === undefined || definition.kind === "bytes_bytes") {
      handed = undefined;
      return;
    }
    const incoming: Chunk = handed ?? UNKNOWN_CHUNK;
    const at = [...path, index, "configuration"];
    if (codec.status === "accepted") {
      const { configuration, nested } = codec;
      issues.push(...prefixed(at, definition.chunkRules?.(configuration, nested, incoming) ?? []));
      for (const [member, received] of Object.entries(
        definition.pipelines?.(configuration, nested, incoming) ?? {},
      )) {
        const held = (configuration[member] as unknown[]).map(
          (_entry, position) => nestedAt(nested, member, position) as ResolvedField,
        );
        issues.push(...pipelineProblems(held, received, [...at, member], { checkEmpty: true }));
      }
    }
    if (definition.kind === "array_bytes") {
      handed = undefined;
    } else if (codec.status !== "accepted") {
      handed = UNKNOWN_CHUNK;
    } else {
      handed = definition.transition?.(codec.configuration, codec.nested, incoming) ?? UNKNOWN_CHUNK;
    }
  });
  return issues;
}
