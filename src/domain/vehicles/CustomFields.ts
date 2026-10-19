import { InvalidVehicleError } from "./VehicleIdentifiers.js";

export type CustomFieldType = "text" | "number" | "date" | "boolean" | "select";

/** A field the business adds to its vehicles (docs/06 §2), defined in its vehicle settings. */
export type CustomFieldDefinition = Readonly<{
  key: string;
  label: string;
  type: CustomFieldType;
  required: boolean;
  /** Choices for `select`. */
  options?: readonly string[];
}>;

export type CustomFieldValue = string | number | boolean;

const KEY = /^[a-z][a-z0-9_]{0,39}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_CUSTOM_FIELDS = 30;

/** Checks the definitions themselves (settings). */
export function validateCustomFieldDefinitions(
  definitions: readonly CustomFieldDefinition[],
): void {
  if (definitions.length > MAX_CUSTOM_FIELDS)
    throw new InvalidVehicleError(`At most ${MAX_CUSTOM_FIELDS} custom fields`);
  const keys = new Set<string>();
  for (const d of definitions) {
    if (!KEY.test(d.key))
      throw new InvalidVehicleError(`Field keys use lowercase letters, digits and _ ("${d.key}")`);
    if (keys.has(d.key)) throw new InvalidVehicleError(`The field ${d.key} is defined twice`);
    keys.add(d.key);
    if (d.type === "select" && (d.options === undefined || d.options.length === 0))
      throw new InvalidVehicleError(`The field ${d.key} needs its choices`);
  }
}

/**
 * Checks a vehicle's custom values against the definitions: unknown keys are refused, values must
 * have the field's type, required fields must be filled. Returns the values to store.
 */
export function validateCustomFields(
  definitions: readonly CustomFieldDefinition[],
  values: Readonly<Record<string, unknown>>,
): Record<string, CustomFieldValue> {
  const byKey = new Map(definitions.map((d) => [d.key, d]));
  const result: Record<string, CustomFieldValue> = {};
  for (const [key, value] of Object.entries(values)) {
    const definition = byKey.get(key);
    if (definition === undefined) throw new InvalidVehicleError(`Unknown custom field "${key}"`);
    if (value === null || value === "") continue;
    result[key] = checked(definition, value);
  }
  for (const d of definitions)
    if (d.required && result[d.key] === undefined)
      throw new InvalidVehicleError(`${d.label} is required`);
  return result;
}

function checked(d: CustomFieldDefinition, value: unknown): CustomFieldValue {
  const wrong = () => new InvalidVehicleError(`${d.label} must be ${describe(d)}`);
  switch (d.type) {
    case "text":
      if (typeof value !== "string" || value.length > 500) throw wrong();
      return value.trim();
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) throw wrong();
      return value;
    case "boolean":
      if (typeof value !== "boolean") throw wrong();
      return value;
    case "date":
      if (typeof value !== "string" || !DATE.test(value)) throw wrong();
      return value;
    case "select":
      if (typeof value !== "string" || !(d.options ?? []).includes(value)) throw wrong();
      return value;
  }
}

function describe(d: CustomFieldDefinition): string {
  switch (d.type) {
    case "text":
      return "text (up to 500 characters)";
    case "number":
      return "a number";
    case "boolean":
      return "true or false";
    case "date":
      return "a date (YYYY-MM-DD)";
    case "select":
      return `one of ${(d.options ?? []).join(", ")}`;
  }
}
