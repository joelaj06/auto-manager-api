import { basename, resolve } from "node:path";
import ts from "typescript";

export type JsonSchema = Record<string, unknown>;

export type ResponseShape =
  | Readonly<{ kind: "json"; envelope: boolean; data: JsonSchema; meta: JsonSchema | null }>
  | Readonly<{ kind: "binary" }>
  | Readonly<{ kind: "empty" }>
  | Readonly<{ kind: "unknown" }>;

/** The parts of a route the extractor needs to find its handler in the source. */
export type RouteLocator = Readonly<{
  file: string;
  method: string;
  path: string;
  summary: string;
  statuses: readonly string[];
}>;

type Handler = Readonly<{
  node: ts.Node;
  bodies: readonly ts.Type[];
  metas: readonly ts.Type[];
  raw: readonly ts.Type[];
  empty: boolean;
  binary: boolean;
}>;

type PathMatcher = Readonly<{
  literals: readonly string[];
  method: string | null;
  handler: Handler;
}>;

type SourceIndex = Readonly<{
  bySummary: Map<string, Handler>;
  byHelperCall: Map<string, Readonly<{ types: readonly ts.Type[]; node: ts.Node }>>;
  byPath: PathMatcher[];
}>;

const NOT_A_NAME = new Set([
  "__type",
  "__object",
  "Array",
  "ReadonlyArray",
  "Readonly",
  "Partial",
  "Required",
  "Pick",
  "Omit",
  "Record",
  "Exclude",
  "Extract",
  "NonNullable",
  "Awaited",
]);
const MAX_DEPTH = 16;
const BINARY_CALL = /pdf|csv/i;

const pascal = (text: string) =>
  text
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join("");

/**
 * Reads what each route answers from the TypeScript types: the argument handed to `envelope()` or
 * `res.json()` in its handler, as JSON would serialise it (Date to a string, `toJSON()` followed,
 * class getters and functions dropped). Named types become shared components; a response with no
 * type name is named after its route.
 */
export class ResponseShapeExtractor {
  readonly components: Record<string, JsonSchema> = {};
  private readonly program: ts.Program;
  private readonly checker: ts.TypeChecker;
  private readonly indexes = new Map<string, SourceIndex>();
  private readonly namedTypes = new Map<ts.Type, string>();
  private readonly namesByContent = new Map<string, string>();

  constructor(tsconfig: string, routesDirectory: string) {
    const parsed = ts.getParsedCommandLineOfConfigFile(
      tsconfig,
      {},
      {
        ...ts.sys,
        onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
          throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
        },
      },
    );
    if (parsed === undefined) throw new Error(`Cannot read ${tsconfig}`);
    this.program = ts.createProgram(parsed.fileNames, parsed.options);
    this.checker = this.program.getTypeChecker();
    const directory = resolve(routesDirectory);
    for (const file of this.program.getSourceFiles()) {
      if (file.fileName.startsWith(directory) && file.fileName.endsWith("Routes.ts")) {
        this.indexes.set(basename(file.fileName), this.indexFile(file));
      }
    }
  }

  /** What the route answers, naming an unnamed body after the route. */
  shapeOf(route: RouteLocator): ResponseShape {
    const index = this.indexes.get(route.file);
    if (index === undefined) return { kind: "unknown" };
    const handler =
      index.bySummary.get(route.summary) ??
      (index.byHelperCall.has(route.summary) ? undefined : this.matchPath(index, route));
    const label = pascal(
      `${route.method.toLowerCase()} ${route.path.replace(/^\/api\/|\/?v1\//g, " ")}`,
    );
    if (handler === undefined) {
      const call = index.byHelperCall.get(route.summary);
      if (call !== undefined && call.types.length > 0) {
        return {
          kind: "json",
          envelope: true,
          data: this.union(call.types, call.node, label),
          meta: null,
        };
      }
      return route.statuses.join() === "204" ? { kind: "empty" } : { kind: "unknown" };
    }
    if (handler.bodies.length > 0) {
      const meta = handler.metas.length > 0 ? this.union(handler.metas, handler.node, null) : null;
      return {
        kind: "json",
        envelope: true,
        data: this.union(handler.bodies, handler.node, label),
        meta,
      };
    }
    if (handler.raw.length > 0) {
      return {
        kind: "json",
        envelope: false,
        data: this.union(handler.raw, handler.node, label),
        meta: null,
      };
    }
    if (handler.binary) return { kind: "binary" };
    const noBody = handler.empty || route.statuses.join() === "204";
    return noBody ? { kind: "empty" } : { kind: "unknown" };
  }

  private matchPath(index: SourceIndex, route: RouteLocator): Handler | undefined {
    return index.byPath.find(
      (candidate) =>
        matchesTemplate(candidate.literals, route.path) &&
        (candidate.method === null || candidate.method.toUpperCase() === route.method),
    )?.handler;
  }

  private indexFile(file: ts.SourceFile): SourceIndex {
    const index: SourceIndex = { bySummary: new Map(), byHelperCall: new Map(), byPath: [] };
    const visit = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node)) this.indexRoute(node, index);
      if (ts.isCallExpression(node)) this.indexHelperCall(node, index);
      ts.forEachChild(node, visit);
    };
    visit(file);
    return index;
  }

  private indexRoute(node: ts.ObjectLiteralExpression, index: SourceIndex): void {
    const property = (name: string) =>
      node.properties.find((candidate) => candidate.name?.getText() === name);
    const handlerProperty = property("handler");
    if (handlerProperty === undefined) return;
    const body = ts.isPropertyAssignment(handlerProperty)
      ? handlerProperty.initializer
      : handlerProperty;
    if (!ts.isFunctionLike(body)) return;
    const handler = this.readHandler(body, node);
    const summary = property("summary");
    if (summary !== undefined && ts.isPropertyAssignment(summary)) {
      for (const text of stringsIn(summary.initializer)) {
        if (!index.bySummary.has(text)) index.bySummary.set(text, handler);
      }
    }
    const path = property("path");
    if (path !== undefined && ts.isPropertyAssignment(path)) {
      const method = property("method");
      index.byPath.push({
        literals: templateLiterals(path.initializer),
        method:
          method !== undefined &&
          ts.isPropertyAssignment(method) &&
          ts.isStringLiteralLike(method.initializer)
            ? method.initializer.text
            : null,
        handler,
      });
    }
  }

  /** `step("path", "Summary", schema, (actor) => …)`: the summary and the function that answers. */
  private indexHelperCall(node: ts.CallExpression, index: SourceIndex): void {
    const texts = node.arguments.filter(ts.isStringLiteralLike).map((text) => text.text);
    if (texts.length === 0) return;
    const types = node.arguments
      .filter(
        (argument) =>
          ts.isArrowFunction(argument) ||
          ts.isFunctionExpression(argument) ||
          ts.isPropertyAccessExpression(argument),
      )
      .flatMap((argument) => {
        const signature = this.checker.getTypeAtLocation(argument).getCallSignatures()[0];
        if (signature === undefined) return [];
        return [
          this.checker.getAwaitedType(signature.getReturnType()) ?? signature.getReturnType(),
        ];
      });
    if (types.length === 0) return;
    for (const text of texts) {
      if (!index.byHelperCall.has(text)) index.byHelperCall.set(text, { types, node });
    }
  }

  private readHandler(fn: ts.Node, node: ts.Node): Handler {
    const bodies: ts.Type[] = [];
    const metas: ts.Type[] = [];
    const raw: ts.Type[] = [];
    let empty = false;
    let binary = false;
    const type = (expression: ts.Expression) => this.checker.getTypeAtLocation(expression);
    const visit = (current: ts.Node): void => {
      if (ts.isCallExpression(current)) {
        const name = calledName(current);
        const target = current.expression.getText();
        const [first, second] = current.arguments;
        if (name === "envelope" && first !== undefined) {
          bodies.push(type(first));
          if (second !== undefined) metas.push(type(second));
        } else if (name === "json" && /^res\b/.test(target) && first !== undefined) {
          const wrapped = ts.isCallExpression(first) && calledName(first) === "envelope";
          if (!wrapped) raw.push(type(first));
        } else if ((name === "end" || name === "sendStatus") && /^res\b/.test(target)) {
          empty = true;
        } else if ((name === "send" && /^res\b/.test(target)) || BINARY_CALL.test(name)) {
          binary = true;
        }
      }
      ts.forEachChild(current, visit);
    };
    visit(fn);
    return { node, bodies, metas, raw, empty, binary };
  }

  private union(types: readonly ts.Type[], node: ts.Node, label: string | null): JsonSchema {
    const unique = new Map<string, JsonSchema>();
    for (const type of types) {
      const schema = this.top(type, node, label);
      unique.set(JSON.stringify(schema), schema);
    }
    const schemas = [...unique.values()];
    return schemas.length === 1 ? schemas[0]! : { anyOf: schemas };
  }

  /** The body itself, or its items: named after the route when the type has no name. */
  private top(type: ts.Type, node: ts.Node, label: string | null): JsonSchema {
    const schema = this.schema(type, node, [], 0);
    if (label === null) return schema;
    if (schema.type === "object") return this.shareByContent(schema, label);
    const items = schema.items as JsonSchema | undefined;
    if (schema.type === "array" && items?.type === "object") {
      return { type: "array", items: this.shareByContent(items, `${label}Item`) };
    }
    return schema;
  }

  private shareByContent(schema: JsonSchema, label: string): JsonSchema {
    const content = JSON.stringify(schema);
    let name = this.namesByContent.get(content);
    if (name === undefined) {
      name = this.freeName(label);
      this.namesByContent.set(content, name);
      this.components[name] = schema;
    }
    return reference(name);
  }

  private freeName(wanted: string): string {
    if (this.components[wanted] === undefined) return wanted;
    for (let suffix = 2; ; suffix += 1) {
      const name = `${wanted}${suffix}`;
      if (this.components[name] === undefined) return name;
    }
  }

  private schema(
    type: ts.Type,
    node: ts.Node,
    stack: readonly ts.Type[],
    depth: number,
  ): JsonSchema {
    if (depth > MAX_DEPTH) return {};
    const flags = type.flags;
    if (flags & ts.TypeFlags.Null) return { type: "null" };
    if (flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void)) return { "x-undefined": true };
    if (type.isStringLiteral()) return { type: "string", const: type.value };
    if (type.isNumberLiteral()) return { type: "number", const: type.value };
    if (flags & ts.TypeFlags.BooleanLike) return { type: "boolean" };
    if (flags & (ts.TypeFlags.String | ts.TypeFlags.TemplateLiteral)) return { type: "string" };
    if (flags & ts.TypeFlags.Number) return { type: "number" };
    if (type.isUnion()) return this.unionSchema(type, node, stack, depth);
    if (!(flags & ts.TypeFlags.Object) && !type.isIntersection()) return {};
    if (type.symbol?.name === "Date") return { type: "string", format: "date-time" };
    if (this.checker.isArrayType(type) || this.checker.isTupleType(type)) {
      const items = this.checker.getTypeArguments(type as ts.TypeReference);
      if (this.checker.isTupleType(type)) {
        return {
          type: "array",
          prefixItems: items.map((item) => this.schema(item, node, stack, depth + 1)),
        };
      }
      return { type: "array", items: this.schema(items[0]!, node, stack, depth + 1) };
    }
    const toJson = this.checker.getPropertyOfType(type, "toJSON");
    if (toJson !== undefined) {
      const signature = this.checker.getTypeOfSymbolAtLocation(toJson, node).getCallSignatures()[0];
      if (signature !== undefined) {
        return this.schema(signature.getReturnType(), node, stack, depth + 1);
      }
    }
    const known = this.namedTypes.get(type);
    if (known !== undefined) return reference(known);
    const name = this.nameOf(type);
    if (name !== null) {
      const unique = this.freeName(name);
      this.namedTypes.set(type, unique);
      this.components[unique] = {};
      this.components[unique] = this.objectSchema(type, node, stack, depth);
      return reference(unique);
    }
    if (stack.includes(type)) return { description: "Recursive" };
    return this.objectSchema(type, node, stack, depth);
  }

  private unionSchema(type: ts.UnionType, node: ts.Node, stack: readonly ts.Type[], depth: number) {
    const parts = type.types
      .map((part) => this.schema(part, node, stack, depth + 1))
      .filter((part) => part["x-undefined"] !== true);
    const literals = parts.filter((part) => part.type === "string" && part.const !== undefined);
    const others = parts.filter((part) => !literals.includes(part));
    const combined =
      literals.length > 1
        ? [{ type: "string", enum: literals.map((part) => part.const as string).sort() }, ...others]
        : parts;
    const unique = [...new Map(combined.map((part) => [JSON.stringify(part), part])).values()];
    return unique.length === 1 ? unique[0]! : { anyOf: unique.sort(byNullLast) };
  }

  private objectSchema(type: ts.Type, node: ts.Node, stack: readonly ts.Type[], depth: number) {
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    const inner = [...stack, type];
    for (const property of this.checker.getPropertiesOfType(type)) {
      const declaration = property.valueDeclaration ?? property.declarations?.[0];
      if (declaration !== undefined && ts.isGetAccessor(declaration)) {
        if (ts.isClassLike(declaration.parent)) continue;
      }
      const propertyType = this.checker.getTypeOfSymbolAtLocation(property, node);
      if (propertyType.getCallSignatures().length > 0) continue;
      properties[property.name] = this.schema(propertyType, node, inner, depth + 1);
      const optional =
        (property.flags & ts.SymbolFlags.Optional) !== 0 ||
        (propertyType.isUnion() &&
          propertyType.types.some((part) => (part.flags & ts.TypeFlags.Undefined) !== 0));
      if (!optional) required.push(property.name);
    }
    const schema: JsonSchema = { type: "object" };
    if (Object.keys(properties).length > 0) schema.properties = properties;
    if (required.length > 0) schema.required = required;
    const index = this.checker.getIndexInfoOfType(type, ts.IndexKind.String);
    if (index !== undefined) {
      schema.additionalProperties = this.schema(index.type, node, inner, depth + 1);
    }
    return schema;
  }

  private nameOf(type: ts.Type): string | null {
    const symbol = type.aliasSymbol ?? type.symbol;
    if (symbol === undefined || NOT_A_NAME.has(symbol.name)) return null;
    const args = type.aliasTypeArguments ?? [];
    const suffix = args.map((arg) => pascal(this.checker.typeToString(arg))).join("");
    return `${symbol.name}${suffix}`;
  }
}

const reference = (name: string): JsonSchema => ({ $ref: `#/components/schemas/${name}` });

const byNullLast = (left: JsonSchema, right: JsonSchema) =>
  Number(left.type === "null") - Number(right.type === "null");

function calledName(call: ts.CallExpression): string {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  return ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
}

function stringsIn(node: ts.Node): string[] {
  const found: string[] = [];
  const visit = (current: ts.Node): void => {
    if (ts.isStringLiteralLike(current)) found.push(current.text);
    ts.forEachChild(current, visit);
  };
  visit(node);
  return found;
}

/** The fixed parts of `${BASE}/staff/:id/${action}`, for the paths a loop builds. */
function templateLiterals(node: ts.Expression): string[] {
  return node
    .getText()
    .replace(/^[`"']|[`"']$/g, "")
    .split(/\$\{[^}]*\}/);
}

function matchesTemplate(literals: readonly string[], path: string): boolean {
  if (literals.length === 1) return literals[0] === path;
  const first = literals[0]!;
  const last = literals.at(-1)!;
  if (!path.startsWith(first) || !path.endsWith(last)) return false;
  let at = first.length;
  for (const literal of literals.slice(1, -1)) {
    const found = path.indexOf(literal, at);
    if (found === -1) return false;
    at = found + literal.length;
  }
  return at <= path.length - last.length;
}
