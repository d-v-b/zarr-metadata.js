import type { PathedIssue } from "../errors.js";
import { fieldParts, isPlainObject } from "../guards.js";
import { issue, named, simple, type DataTypeDescriptor } from "./descriptor.js";

/**
 * Core data type names, which a struct field "MUST" spell as a string.
 *   https://github.com/zarr-developers/zarr-extensions/blob/4da7b37a84f76e660902f6d3de3eaef0e0febae6/data-types/struct/README.md#L45
 */
const CORE_NAMES = new Set([
  "bool",
  "int8", "int16", "int32", "int64",
  "uint8", "uint16", "uint32", "uint64",
  "float16", "float32", "float64",
  "complex64", "complex128",
]);

/**
 * Variable-length data types, which "MUST NOT be used as field types".
 *   https://github.com/zarr-developers/zarr-extensions/blob/4da7b37a84f76e660902f6d3de3eaef0e0febae6/data-types/struct/README.md#L48-L49
 */
const VARIABLE_LENGTH_NAMES = new Set(["string", "bytes"]);

/** One field of a `struct` data type; `data_type` recurses (structs may nest). */
export interface StructField {
  name: string;
  data_type: unknown;
}

/** Configuration of the `struct` data type. */
export interface StructConfiguration {
  fields: StructField[];
}

/**
 * The zarr-extensions `struct` data type (heterogeneous record). Its fill
 * value is a JSON object mapping every field name to that field's fill
 * value, each judged recursively against the field's own data type. Field
 * names "MUST be unique".
 *   https://github.com/zarr-developers/zarr-extensions/blob/4da7b37a84f76e660902f6d3de3eaef0e0febae6/data-types/struct/README.md#L221-L223
 *   https://github.com/zarr-developers/zarr-extensions/blob/4da7b37a84f76e660902f6d3de3eaef0e0febae6/data-types/struct/README.md#L263
 */
export const struct: DataTypeDescriptor = {
  matches: named("struct"),
  requiredConfigKeys: ["fields"],
  configIssues: (configuration, _name, context) => {
    const fields = configuration["fields"];
    if (!Array.isArray(fields)) return []; // config shape is the schema layer's problem
    const issues: PathedIssue[] = [];
    const seen = new Set<string>();
    fields.forEach((field, index) => {
      if (!isPlainObject(field)) return;
      const fieldName = field["name"];
      if (typeof fieldName === "string") {
        if (seen.has(fieldName)) {
          issues.push(
            issue(["fields", index, "name"], `duplicate field name ${JSON.stringify(fieldName)}`),
          );
        }
        seen.add(fieldName);
      }
      const dataType = field["data_type"];
      const parts = fieldParts(dataType);
      if (parts === undefined) return;
      const dataTypePath = ["fields", index, "data_type"];
      if (VARIABLE_LENGTH_NAMES.has(parts.name)) {
        issues.push(
          issue(
            dataTypePath,
            `${JSON.stringify(parts.name)} is variable-length and cannot be a struct field type`,
          ),
        );
      } else if (typeof dataType !== "string" && CORE_NAMES.has(parts.name)) {
        issues.push(
          issue(
            dataTypePath,
            `core data type ${JSON.stringify(parts.name)} must be spelled as a string in a struct field`,
          ),
        );
      }
      issues.push(
        ...context
          .configIssuesFor(dataType, context.depth + 1)
          .map((inner) => ({ ...inner, path: [...dataTypePath, ...inner.path] })),
      );
    });
    return issues;
  },
  fillIssues: (fill, _name, context) => {
    if (!isPlainObject(fill)) {
      return simple('expected an object mapping field names to fill values for data type "struct"');
    }
    const fields = context.configuration?.["fields"];
    if (!Array.isArray(fields)) return []; // config shape is the schema layer's problem
    const declared = new Map<string, unknown>();
    for (const field of fields) {
      if (isPlainObject(field) && typeof field["name"] === "string") {
        declared.set(field["name"], field["data_type"]);
      }
    }
    // Malformed or duplicate fields: the schema layer's or configIssues' problem.
    if (declared.size !== fields.length) return [];
    const issues = [];
    for (const [fieldName, dataType] of declared) {
      if (!Object.hasOwn(fill, fieldName)) {
        issues.push(issue([fieldName], "missing required key", "missing_key"));
        continue;
      }
      issues.push(
        ...context
          .fillIssuesFor(dataType, fill[fieldName], context.depth + 1)
          .map((inner) => ({ ...inner, path: [fieldName, ...inner.path] })),
      );
    }
    for (const key of Object.keys(fill)) {
      if (!declared.has(key)) {
        issues.push(issue([key], "unexpected member (no such struct field)"));
      }
    }
    return issues;
  },
};
