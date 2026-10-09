// A small JSON Schema checker for tool arguments. It knows a fixed set of
// keywords. defineTools refuses any other keyword, so no schema rule is
// skipped without notice (docs/failure-modes.md R2).
import { FoxloopError } from "./errors.js";
import type { JsonSchema } from "./types.js";

const TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const RULES = new Set(["type", "properties", "required", "additionalProperties", "enum", "minLength", "maxLength", "minimum", "maximum", "items", "minItems", "maxItems"]);
const NOTES = new Set(["description", "title", "default", "examples"]);

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Throws FoxloopError `bad-schema` for a schema that checkArgs cannot enforce. */
export function assertSchema(schema: unknown, path = "parameters"): void {
  const fail = (why: string): never => {
    throw new FoxloopError("bad-schema", `${path}: ${why}`);
  };
  if (!isObject(schema)) fail("must be an object");
  const node = schema as JsonSchema;
  for (const key of Object.keys(node)) {
    if (!RULES.has(key) && !NOTES.has(key)) fail(`the keyword "${key}" is not supported`);
  }
  if (typeof node.type !== "string" || !TYPES.has(node.type)) fail("needs a single \"type\"");
  if (node.additionalProperties !== undefined && typeof node.additionalProperties !== "boolean") fail("additionalProperties must be true or false");
  if (node.enum !== undefined && !Array.isArray(node.enum)) fail("enum must be an array");
  if (node.required !== undefined && !(Array.isArray(node.required) && node.required.every((r) => typeof r === "string"))) fail("required must list names");
  if (node.properties !== undefined) {
    if (!isObject(node.properties)) fail("properties must be an object");
    for (const [name, child] of Object.entries(node.properties as Record<string, unknown>)) assertSchema(child, `${path}.${name}`);
  }
  if (node.items !== undefined) assertSchema(node.items, `${path}[]`);
}

const typeOf = (value: unknown): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
};

const fits = (want: string, value: unknown) => {
  const got = typeOf(value);
  return got === want || (want === "number" && got === "integer");
};

function check(schema: JsonSchema, value: unknown, path: string): string | null {
  const at = path || "arguments";
  const want = schema.type as string;
  if (!fits(want, value)) return `${at}: must be ${want}, got ${typeOf(value)}`;
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => option === value)) return `${at}: must be one of ${JSON.stringify(schema.enum)}`;
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) return `${at}: shorter than ${schema.minLength} characters`;
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return `${at}: longer than ${schema.maxLength} characters`;
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) return `${at}: below ${schema.minimum}`;
    if (typeof schema.maximum === "number" && value > schema.maximum) return `${at}: above ${schema.maximum}`;
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return `${at}: fewer than ${schema.minItems} items`;
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return `${at}: more than ${schema.maxItems} items`;
    if (isObject(schema.items)) {
      for (const [index, item] of value.entries()) {
        const error = check(schema.items, item, `${path}[${index}]`);
        if (error) return error;
      }
    }
  }
  if (isObject(value)) {
    const properties = isObject(schema.properties) ? schema.properties : {};
    for (const name of (schema.required as string[] | undefined) ?? []) {
      if (!(name in value)) return `${path ? `${path}.` : ""}${name}: is required`;
    }
    for (const [name, item] of Object.entries(value)) {
      const where = path ? `${path}.${name}` : name;
      const child = properties[name];
      if (isObject(child)) {
        const error = check(child, item, where);
        if (error) return error;
      } else if (schema.additionalProperties !== true) {
        return `${where}: is not allowed (the schema does not name it)`;
      }
    }
  }
  return null;
}

/**
 * Checks model arguments against a tool schema. Returns null when they fit,
 * else the path of the first error. Properties the schema does not name are
 * refused unless it sets `additionalProperties: true`.
 */
export function checkArgs(schema: JsonSchema, value: unknown): string | null {
  if (!isObject(value)) return `arguments: must be a JSON object, got ${typeOf(value)}`;
  return check(schema, value, "");
}
