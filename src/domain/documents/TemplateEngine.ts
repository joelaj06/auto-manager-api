import { DomainError } from "../errors/DomainError.js";
import { Money } from "../money/Money.js";

export class DocumentTemplateError extends DomainError {
  readonly code = "DOCUMENT_TEMPLATE";
  constructor(message: string) {
    super(message);
  }
}

/** What a field holds, for checking templates before they are used. */
export type FieldType = "text" | "number" | "money" | "date" | "boolean";
/** The fields a document type offers its templates (nested objects and lists of objects). */
export type FieldSchema = { readonly [name: string]: FieldType | FieldSchema | ListOf };
export type ListOf = Readonly<{ $list: FieldSchema }>;

export const listOf = (item: FieldSchema): ListOf => ({ $list: item });

export const HELPERS = ["money", "date", "number", "upper"] as const;
type Helper = (typeof HELPERS)[number];

type Node =
  | Readonly<{ kind: "text"; text: string }>
  | Readonly<{ kind: "var"; path: string; helper: Helper | null; line: number }>
  | Readonly<{ kind: "each"; path: string; body: Node[]; line: number }>
  | Readonly<{
      kind: "if";
      path: string;
      negate: boolean;
      then: Node[];
      otherwise: Node[];
      line: number;
    }>;

const PATH = /^(@index|@number|this(\.[A-Za-z_]\w*)*|[A-Za-z_]\w*(\.[A-Za-z_]\w*)*)$/;
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const escapeHtml = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const isMoney = (v: unknown): v is { amountMinor: number; currency: string } =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as { amountMinor?: unknown }).amountMinor === "number" &&
  typeof (v as { currency?: unknown }).currency === "string";

/** "2026-10-20" or an ISO timestamp → "20 October 2026". */
export function longDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (match === null) return value;
  return `${Number(match[3])} ${MONTHS[Number(match[2]) - 1] ?? ""} ${match[1]}`;
}

/**
 * The document template language (docs/24 §3): a small, logic-less Mustache dialect — no code,
 * no raw HTML output, every value HTML-escaped.
 *
 * - `{{driver.name}}` a field; `{{money terms.target}}`, `{{date issuedOn}}`, `{{number km}}`,
 *   `{{upper vehicle.plateNumber}}` with a formatter
 * - `{{#each checklist}} … {{label}} … {{@number}} … {{/each}}` repeats for a list
 * - `{{#if guarantor}} … {{else}} … {{/if}}`, `{{#unless …}} … {{/unless}}`
 * - `{{! a comment }}`
 *
 * Templates are checked against the document type's fields before they are saved, so a typo
 * fails when the template is written, not when a document is issued.
 */
export class Template {
  private constructor(private readonly nodes: readonly Node[]) {}

  static compile(source: string): Template {
    if (source.includes("{{{"))
      throw new DocumentTemplateError("Raw output ({{{ … }}}) is not allowed");
    const tokens = tokenize(source);
    const [nodes, rest] = parse(tokens, 0, null);
    const extra = tokens[rest];
    if (extra?.kind === "tag")
      throw new DocumentTemplateError(`Unexpected {{${extra.tag}}} on line ${extra.line}`);
    return new Template(nodes);
  }

  /** Throws for a field the schema does not have or a formatter that does not fit it. */
  check(schema: FieldSchema): void {
    checkNodes(this.nodes, [schema]);
  }

  render(data: Readonly<Record<string, unknown>>): string {
    return renderNodes(this.nodes, [data], 0);
  }
}

type Token =
  Readonly<{ kind: "text"; text: string }> | Readonly<{ kind: "tag"; tag: string; line: number }>;

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  for (;;) {
    const open = source.indexOf("{{", at);
    if (open === -1) {
      if (at < source.length) tokens.push({ kind: "text", text: source.slice(at) });
      return tokens;
    }
    if (open > at) tokens.push({ kind: "text", text: source.slice(at, open) });
    const close = source.indexOf("}}", open + 2);
    const line = source.slice(0, open).split("\n").length;
    if (close === -1) throw new DocumentTemplateError(`Unclosed {{ on line ${line}`);
    const tag = source.slice(open + 2, close).trim();
    if (!tag.startsWith("!")) tokens.push({ kind: "tag", tag, line });
    at = close + 2;
  }
}

/** Parses until the closing tag of `block` (null: the end); returns nodes and the next index. */
function parse(
  tokens: readonly Token[],
  start: number,
  block: Readonly<{ name: "each" | "if" | "unless"; line: number }> | null,
): [Node[], number, boolean] {
  const nodes: Node[] = [];
  let i = start;
  while (i < tokens.length) {
    const token = tokens[i]!;
    if (token.kind === "text") {
      nodes.push({ kind: "text", text: token.text });
      i += 1;
      continue;
    }
    const { tag, line } = token;
    if (tag === "else") {
      if (block === null || block.name === "each")
        throw new DocumentTemplateError(`{{else}} outside {{#if}} on line ${line}`);
      return [nodes, i + 1, true];
    }
    if (tag.startsWith("/")) {
      const name = tag.slice(1).trim();
      if (block === null || name !== block.name)
        throw new DocumentTemplateError(`Unexpected {{${tag}}} on line ${line}`);
      return [nodes, i + 1, false];
    }
    if (tag.startsWith("#")) {
      const [name, path, ...more] = tag.slice(1).trim().split(/\s+/);
      if ((name !== "each" && name !== "if" && name !== "unless") || more.length > 0)
        throw new DocumentTemplateError(`Unknown block {{${tag}}} on line ${line}`);
      if (path === undefined || !PATH.test(path))
        throw new DocumentTemplateError(`{{#${name}}} needs a field on line ${line}`);
      const [body, next, hitElse] = parse(tokens, i + 1, { name, line });
      if (name === "each") {
        nodes.push({ kind: "each", path, body, line });
        i = next;
        continue;
      }
      let otherwise: Node[] = [];
      i = next;
      if (hitElse) [otherwise, i] = parse(tokens, next, { name, line });
      nodes.push({ kind: "if", path, negate: name === "unless", then: body, otherwise, line });
      continue;
    }
    const parts = tag.split(/\s+/);
    const [first, second] = parts;
    if (parts.length > 2 || first === undefined)
      throw new DocumentTemplateError(`Cannot read {{${tag}}} on line ${line}`);
    if (second !== undefined) {
      if (!(HELPERS as readonly string[]).includes(first))
        throw new DocumentTemplateError(
          `Unknown formatter "${first}" on line ${line}; use ${HELPERS.join(", ")}`,
        );
      if (!PATH.test(second))
        throw new DocumentTemplateError(`Cannot read {{${tag}}} on line ${line}`);
      nodes.push({ kind: "var", path: second, helper: first as Helper, line });
    } else {
      if (!PATH.test(first))
        throw new DocumentTemplateError(`Cannot read {{${tag}}} on line ${line}`);
      nodes.push({ kind: "var", path: first, helper: null, line });
    }
    i += 1;
  }
  if (block !== null)
    throw new DocumentTemplateError(`{{#${block.name}}} on line ${block.line} is never closed`);
  return [nodes, i, false];
}

type SchemaEntry = FieldType | FieldSchema | ListOf;

function resolveSchema(
  path: string,
  scopes: readonly FieldSchema[],
): SchemaEntry | "index" | undefined {
  if (path === "@index" || path === "@number") return scopes.length > 1 ? "index" : undefined;
  const parts = path.split(".");
  let entry: SchemaEntry | undefined;
  if (parts[0] === "this") {
    entry = scopes.at(-1);
    parts.shift();
  } else {
    const owner = [...scopes].reverse().find((s) => Object.hasOwn(s, parts[0]!));
    entry = owner;
  }
  for (const part of parts) {
    if (entry === undefined || typeof entry === "string" || "$list" in entry) return undefined;
    entry = Object.hasOwn(entry, part) ? entry[part] : undefined;
  }
  return entry;
}

function checkNodes(nodes: readonly Node[], scopes: readonly FieldSchema[]): void {
  for (const node of nodes) {
    if (node.kind === "text") continue;
    const entry = resolveSchema(node.path, scopes);
    if (entry === undefined)
      throw new DocumentTemplateError(`Unknown field "${node.path}" on line ${node.line}`);
    if (node.kind === "each") {
      if (typeof entry === "string" || !("$list" in entry))
        throw new DocumentTemplateError(`"${node.path}" on line ${node.line} is not a list`);
      checkNodes(node.body, [...scopes, (entry as ListOf).$list]);
      continue;
    }
    if (node.kind === "if") {
      checkNodes(node.then, scopes);
      checkNodes(node.otherwise, scopes);
      continue;
    }
    const type = typeof entry === "string" ? entry : null;
    if (type === null)
      throw new DocumentTemplateError(
        `"${node.path}" on line ${node.line} is a group of fields; pick one of them`,
      );
    const fits: Record<Helper, readonly string[]> = {
      money: ["money"],
      date: ["date"],
      number: ["number", "index"],
      upper: ["text"],
    };
    if (node.helper === null && (type === "money" || type === "date"))
      throw new DocumentTemplateError(
        `Write {{${type} ${node.path}}} on line ${node.line} to format the ${type}`,
      );
    if (node.helper !== null && !fits[node.helper].includes(type))
      throw new DocumentTemplateError(
        `{{${node.helper} …}} does not fit "${node.path}" (${type}) on line ${node.line}`,
      );
  }
}

type Scope = Readonly<Record<string, unknown>>;

function lookup(path: string, scopes: readonly Scope[], index: number): unknown {
  if (path === "@index") return index;
  if (path === "@number") return index + 1;
  const parts = path.split(".");
  let value: unknown;
  if (parts[0] === "this") {
    value = scopes.at(-1);
    parts.shift();
  } else {
    value = [...scopes].reverse().find((s) => Object.hasOwn(s, parts[0]!));
  }
  for (const part of parts) {
    if (typeof value !== "object" || value === null || !Object.hasOwn(value, part))
      return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

const truthy = (v: unknown) =>
  !(
    v === undefined ||
    v === null ||
    v === false ||
    v === "" ||
    v === 0 ||
    (Array.isArray(v) && v.length === 0)
  );

function display(value: unknown, helper: Helper | null): string {
  if (value === undefined || value === null) return "";
  if (helper === "money" || (helper === null && isMoney(value)))
    return isMoney(value) ? Money.ofMinor(value.amountMinor, value.currency).formatAscii() : "";
  if (helper === "date") return typeof value === "string" ? longDate(value) : "";
  if (helper === "number")
    return typeof value === "number" ? new Intl.NumberFormat("en-GB").format(value) : "";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value !== "string" && typeof value !== "number") return "";
  const text = String(value);
  return helper === "upper" ? text.toUpperCase() : text;
}

function renderNodes(nodes: readonly Node[], scopes: readonly Scope[], index: number): string {
  let out = "";
  for (const node of nodes) {
    if (node.kind === "text") out += node.text;
    else if (node.kind === "var")
      out += escapeHtml(display(lookup(node.path, scopes, index), node.helper));
    else if (node.kind === "each") {
      const list = lookup(node.path, scopes, index);
      if (!Array.isArray(list)) continue;
      (list as unknown[]).forEach((item, i) => {
        const scope = typeof item === "object" && item !== null ? (item as Scope) : { this: item };
        out += renderNodes(node.body, [...scopes, scope], i);
      });
    } else {
      const on = truthy(lookup(node.path, scopes, index)) !== node.negate;
      out += renderNodes(on ? node.then : node.otherwise, scopes, index);
    }
  }
  return out;
}
