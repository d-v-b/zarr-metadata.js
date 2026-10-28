import {
  configured,
  fillValueProblems,
  field,
  nestedAt,
  storageOf,
  type DataTypeDefinition,
  type StorageClass,
} from "../definition.js";
import { append, type PathedIssue } from "../errors.js";
import { issue, json, mappingOf, objectOf, required, sequenceOf, show, string } from "../typed.js";

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
 * The zarr-extensions `struct` data type (a record of named fields). Each
 * field's data type is a nested field, read in the same scope. There is at
 * least one field; names are non-empty and distinct, since a fill value
 * addresses fields by name; and no field type varies in size ("Variable-
 * length data types MUST NOT be used as field types"). The fill value is
 * an object with an entry for every field and nothing else, each judged
 * against its field's own type.
 */
export const struct: DataTypeDefinition<StructConfiguration, Record<string, unknown>> = {
  name: "struct",
  ...configured({
    fields: required(
      sequenceOf(objectOf({ name: required(string), data_type: required(field("data_type")) })),
    ),
  }),
  rules: ({ fields }, nested) => {
    const issues: PathedIssue[] = [];
    if (fields.length === 0) {
      issues.push(issue(["fields"], "expected at least one struct field", "invalid_value"));
    }
    const seen = new Map<string, number>();
    fields.forEach((member, index) => {
      if (member.name === "") {
        issues.push(issue(["fields", index, "name"], "expected a non-empty field name", "invalid_value"));
      }
      const first = seen.get(member.name);
      if (first === undefined) {
        seen.set(member.name, index);
      } else {
        issues.push(
          issue(
            ["fields", index, "name"],
            `duplicate field name ${show(member.name)}, already used by field ${first}`,
            "invalid_value",
          ),
        );
      }
      const fieldType = nestedAt(nested, "fields", index, "data_type");
      if (storageOf(fieldType) === "variable_length") {
        issues.push(
          issue(
            ["fields", index, "data_type"],
            `expected a data type of fixed size, got ${show(fieldType?.name)}, whose values vary in size`,
            "invalid_value",
          ),
        );
      }
    });
    return issues;
  },
  fillValue: mappingOf(json),
  fillValueRules: ({ fields }, nested, value) => {
    const issues: PathedIssue[] = [];
    const declared = new Set(fields.map((member) => member.name));
    fields.forEach((member, index) => {
      if (!Object.hasOwn(value, member.name)) {
        issues.push(
          issue([member.name], `expected a fill value for struct field ${show(member.name)}`, "missing_key"),
        );
        return;
      }
      const fieldType = nestedAt(nested, "fields", index, "data_type");
      append(issues, fillValueProblems(fieldType, value[member.name], [member.name]));
    });
    for (const key of Object.keys(value)) {
      if (!declared.has(key)) issues.push(issue([key], `no struct field is named ${show(key)}`, "unknown_key"));
    }
    return issues;
  },
  // The packed field values: multi-byte if any field holds multi-byte
  // numbers, single-byte if every field is single-byte, else unknown.
  storage: ({ fields }, nested) => {
    const found = new Set<StorageClass | undefined>(
      fields.map((_member, index) => storageOf(nestedAt(nested, "fields", index, "data_type"))),
    );
    if (found.has("multi_byte")) return "multi_byte";
    return found.size === 1 && found.has("single_byte") ? "single_byte" : undefined;
  },
};
