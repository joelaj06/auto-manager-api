import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildOpenApiDocument } from "../../adapters/presenters/openApiPresenter.js";
import type { ApiRoute } from "../../adapters/routes/ApiRoute.js";
import { log, runCommand } from "./runCommand.js";
import {
  ResponseShapeExtractor,
  type JsonSchema,
  type ResponseShape,
  type RouteLocator,
} from "./ResponseShapeExtractor.js";

const ROUTES = "src/adapters/routes";
const OPENAPI_FILE = "docs/api/openapi.json";
const REFERENCE_FILE = "docs/39_api_response_shapes.md";
const REFERENCE_LINK = (name: string) => `[${name}](#${name.toLowerCase()})`;

type Located = Readonly<{ route: ApiRoute; file: string }>;

/** Route factories only keep their dependencies for handlers, so nothing here is ever called. */
function stubDependencies(): unknown {
  return new Proxy(function stub() {}, {
    get: (_target, key) => {
      if (key === Symbol.toPrimitive) return () => "stub";
      if (key === Symbol.iterator) return function* empty() {};
      return key === "then" ? undefined : stubDependencies();
    },
    apply: () => stubDependencies(),
    construct: () => stubDependencies() as object,
  });
}

async function allRoutes(): Promise<Located[]> {
  const located: Located[] = [];
  const files = readdirSync(ROUTES).filter((file) => file.endsWith("Routes.ts"));
  for (const file of files) {
    const module = (await import(resolve(ROUTES, file))) as Record<string, unknown>;
    for (const factory of Object.values(module)) {
      if (typeof factory !== "function") continue;
      let built: unknown;
      try {
        built = (factory as (deps: unknown) => unknown)(stubDependencies());
      } catch {
        continue; // A helper that is not a route factory.
      }
      if (!Array.isArray(built)) continue;
      for (const route of built as ApiRoute[]) {
        if (typeof route?.path === "string") located.push({ route, file });
      }
    }
  }
  return located;
}

const locator = ({ route, file }: Located): RouteLocator => ({
  file,
  method: route.method.toUpperCase(),
  path: route.path,
  summary: route.summary,
  statuses: Object.keys(route.responses),
});

const declaresSchema = (route: ApiRoute) =>
  Object.values(route.responses).some((response) => response.schema !== undefined);

function successStatus(route: ApiRoute): string {
  return Object.keys(route.responses).find((status) => status.startsWith("2")) ?? "200";
}

function bodyOf(shape: Extract<ResponseShape, { kind: "json" }>): JsonSchema {
  if (!shape.envelope) return shape.data;
  const properties: Record<string, JsonSchema> = { data: shape.data };
  if (shape.meta !== null) properties.meta = shape.meta;
  return { type: "object", properties, required: ["data"] };
}

type OpenApiDocument = ReturnType<typeof buildOpenApiDocument>;
type Operation = { responses: Record<string, Record<string, unknown>> };

function addResponses(
  document: OpenApiDocument,
  routes: readonly Located[],
  shapes: ReadonlyMap<ApiRoute, ResponseShape>,
) {
  for (const { route } of routes) {
    const shape = shapes.get(route);
    const path = route.path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
    const operation = document.paths[path]?.[route.method] as Operation | undefined;
    if (shape === undefined || operation === undefined) continue;
    for (const [status, response] of Object.entries(operation.responses)) {
      if (!status.startsWith("2") || status === "204") continue;
      if (shape.kind === "json") {
        response.content = { "application/json": { schema: bodyOf(shape) } };
      }
      if (shape.kind === "binary") response["x-binary"] = true;
    }
  }
}

function typeText(schema: JsonSchema | undefined): string {
  if (schema === undefined) return "any";
  const ref = schema.$ref as string | undefined;
  if (ref !== undefined) return REFERENCE_LINK(ref.split("/").pop()!);
  if (schema.format === "date-time") return "date-time";
  const fixed = schema.const;
  if (typeof fixed === "string" || typeof fixed === "number") return `"${fixed}"`;
  if (Array.isArray(schema.enum)) return schema.enum.map((value) => `"${value}"`).join(" / ");
  if (Array.isArray(schema.anyOf)) {
    return (schema.anyOf as JsonSchema[]).map((part) => typeText(part)).join(" / ");
  }
  if (schema.type === "array") {
    const items = typeText(schema.items as JsonSchema | undefined);
    return items.includes(" / ") ? `(${items})[]` : `${items}[]`;
  }
  if (schema.type === "object") {
    return schema.additionalProperties === undefined ? "object" : "map";
  }
  return typeof schema.type === "string" ? schema.type : "any";
}

/** Table rows for an object, following unnamed nested objects as dotted fields. */
function fieldRows(schema: JsonSchema, prefix: string): string[] {
  const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
  const required = new Set((schema.required ?? []) as string[]);
  return Object.entries(properties).flatMap(([name, field]) => {
    const fieldName = `${prefix}${name}`;
    const type = typeText(field).replaceAll("|", "/");
    const row = `| \`${fieldName}\` | ${type} | ${required.has(name) ? "Yes" : ""} |`;
    const nested = nestedObject(field);
    if (nested === null) return [row];
    const suffix = field.type === "array" ? "[]." : ".";
    return [row, ...fieldRows(nested, `${fieldName}${suffix}`)];
  });
}

function nestedObject(field: JsonSchema): JsonSchema | null {
  const candidates = Array.isArray(field.anyOf) ? (field.anyOf as JsonSchema[]) : [field];
  for (const candidate of candidates) {
    if (candidate.type === "object" && candidate.properties !== undefined) return candidate;
    const items = candidate.items as JsonSchema | undefined;
    if (candidate.type === "array" && items?.type === "object") return items;
  }
  return null;
}

function returnsText(shape: ResponseShape | undefined, route: ApiRoute): string {
  if (shape === undefined || shape.kind === "unknown") return "See OpenAPI";
  if (shape.kind === "binary") return "File";
  if (shape.kind === "empty") return `No body (${successStatus(route)})`;
  return typeText(shape.data).replaceAll("|", "/");
}

function reference(
  routes: readonly Located[],
  shapes: ReadonlyMap<ApiRoute, ResponseShape>,
  components: Readonly<Record<string, JsonSchema>>,
) {
  const lines = [
    "# 39 — API response shapes",
    "",
    "> Generated by `yarn docs:api` from the TypeScript types behind each route. Do not edit by hand. The same shapes are in [api/openapi.json](api/openapi.json) for generating typed clients.",
    "",
    "## Reading this document",
    "",
    "- Most routes answer `{ data }` or `{ data, meta }`. **Returns** below is the type of `data`. Routes that answer without the envelope are marked.",
    "- **Required** blank means the field can be left out. A field that is present but empty is shown with `null` in its type.",
    '- Money is an object, `{ amountMinor, currency, formatted }`: calculate with `amountMinor` and display `formatted`. Fields ending in `Minor` are amounts in minor units (pesewas). Note that **requests** send money as text, for example `"250.00"`.',
    "- `date-time` is an ISO 8601 string. Plain dates arrive as `YYYY-MM-DD` strings.",
    "- `map` is an object whose keys are data, and `any` a value with no fixed shape (provider payloads, custom fields).",
    "",
    "## Routes",
    "",
    "| Method | Path | Returns |",
    "|---|---|---|",
  ];
  for (const { route } of routes) {
    const shape = shapes.get(route);
    const raw = shape?.kind === "json" && !shape.envelope ? " (no envelope)" : "";
    const text = declaresSchema(route) ? "See OpenAPI" : returnsText(shape, route);
    lines.push(`| ${route.method.toUpperCase()} | \`${route.path}\` | ${text}${raw} |`);
  }
  lines.push("", "## Shapes", "");
  for (const name of Object.keys(components).sort()) {
    const rows = fieldRows(components[name]!, "");
    lines.push(`### ${name}`, "");
    lines.push("| Field | Type | Required |", "|---|---|---|", ...rows, "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * yarn docs:api [--check] — writes docs/api/openapi.json and docs/39_api_response_shapes.md with
 * every route's response read from the TypeScript types. `--check` fails if they are out of date.
 */
runCommand("docs:api", async () => {
  const { values } = parseArgs({ options: { check: { type: "boolean", default: false } } });
  const located = await allRoutes();
  const extractor = new ResponseShapeExtractor("tsconfig.json", ROUTES);
  const shapes = new Map<ApiRoute, ResponseShape>();
  for (const entry of located) {
    if (!declaresSchema(entry.route)) shapes.set(entry.route, extractor.shapeOf(locator(entry)));
  }
  const { version } = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
  const document = buildOpenApiDocument(
    located.map(({ route }) => route),
    { title: "Autoforce API", version },
  );
  addResponses(document, located, shapes);
  const complete = {
    ...document,
    components: { ...document.components, schemas: extractor.components },
  };
  const outputs: readonly (readonly [string, string])[] = [
    [OPENAPI_FILE, `${JSON.stringify(complete, null, 2)}\n`],
    [REFERENCE_FILE, reference(located, shapes, extractor.components)],
  ];
  const unknown = [...shapes.values()].filter((shape) => shape.kind === "unknown").length;
  for (const { route } of located) {
    if (shapes.get(route)?.kind === "unknown") {
      log(`unresolved: ${route.method.toUpperCase()} ${route.path}`);
    }
  }
  log(
    `${located.length} routes, ${Object.keys(extractor.components).length} shapes, ${unknown} unresolved`,
  );
  if (values.check) {
    const stale = outputs.filter(([file, text]) => readSafely(file) !== text).map(([file]) => file);
    if (stale.length > 0) console.error(`Out of date, run yarn docs:api: ${stale.join(", ")}`);
    return stale.length > 0 ? 1 : 0;
  }
  for (const [file, text] of outputs) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    log(`wrote ${file}`);
  }
  return 0;
});

function readSafely(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}
