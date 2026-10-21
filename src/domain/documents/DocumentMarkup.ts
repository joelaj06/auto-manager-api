import { DocumentTemplateError } from "./TemplateEngine.js";

/** A piece of text with its inline style. */
export type Run = Readonly<{ text: string; bold?: boolean; italic?: boolean; underline?: boolean }>;
export type Align = "left" | "center" | "right" | "justify";

/** The layout of a rendered document, independent of how it is drawn. */
export type LayoutBlock =
  | Readonly<{ kind: "heading"; level: 1 | 2 | 3; runs: readonly Run[]; align: Align }>
  | Readonly<{ kind: "paragraph"; runs: readonly Run[]; align: Align; small: boolean }>
  | Readonly<{ kind: "list"; ordered: boolean; items: readonly (readonly Run[])[] }>
  | Readonly<{
      kind: "table";
      header: readonly string[] | null;
      rows: readonly (readonly string[])[];
      /** Column shares (add up to 1). */
      widths: readonly number[];
    }>
  | Readonly<{ kind: "rule" }>
  | Readonly<{ kind: "page_break" }>
  | Readonly<{
      kind: "signatures";
      signers: readonly Readonly<{ role: string; label: string; name: string }>[];
    }>;

type Element = Readonly<{
  kind: "element";
  tag: string;
  attrs: Readonly<Record<string, string>>;
  children: readonly MarkupNode[];
  line: number;
}>;
type TextNode = Readonly<{ kind: "text"; text: string }>;
type MarkupNode = Element | TextNode;

const CLASSES = ["center", "right", "justify", "small", "page-break"];
/** Elements and the attributes each may carry. */
const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  h1: ["class"],
  h2: ["class"],
  h3: ["class"],
  p: ["class"],
  ul: [],
  ol: [],
  li: [],
  table: [],
  thead: [],
  tbody: [],
  tr: [],
  th: ["data-width"],
  td: ["data-width"],
  hr: [],
  br: [],
  strong: [],
  b: [],
  em: [],
  i: [],
  u: [],
  section: ["data-clause", "data-locked", "data-title"],
  div: ["class"],
  "signature-block": [],
  signer: ["role", "label", "name"],
};
const VOID = new Set(["hr", "br"]);
const INLINE = new Set(["strong", "b", "em", "i", "u", "br"]);
const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
  apos: "'",
  nbsp: " ",
};

const decode = (text: string) =>
  text.replace(/&(#\d{1,6}|[a-z]+|#39);/g, (match, name: string) => {
    if (ENTITIES[name] !== undefined) return ENTITIES[name];
    if (name.startsWith("#")) return String.fromCodePoint(Number(name.slice(1)));
    return match;
  });

const TAG = /<\/?([a-z][a-z0-9-]*)((?:\s+[a-z][a-z-]*(?:\s*=\s*"[^"]*")?)*)\s*(\/?)>/gy;
const ATTR = /([a-z][a-z-]*)(?:\s*=\s*"([^"]*)")?/g;

/**
 * The markup document templates are written in (docs/24 §3): a small, safe subset of HTML —
 * headings, paragraphs, lists, tables, rules, page breaks, inline bold/italic/underline,
 * `<section data-clause="id" data-locked>` clauses and `<signature-block>` with `<signer>`s.
 * Anything else (scripts, styles, links, images, other attributes) is refused.
 */
export class DocumentMarkup {
  private constructor(private readonly nodes: readonly MarkupNode[]) {}

  static parse(source: string): DocumentMarkup {
    return new DocumentMarkup(parseNodes(source));
  }

  /** The clauses of the document: id → whether locked and their canonical content. */
  clauses(): Map<string, Readonly<{ locked: boolean; content: string; title: string | null }>> {
    const found = new Map<string, { locked: boolean; content: string; title: string | null }>();
    const visit = (nodes: readonly MarkupNode[]) => {
      for (const node of nodes) {
        if (node.kind !== "element") continue;
        if (node.tag === "section") {
          const id = node.attrs["data-clause"];
          if (id === undefined || !/^[a-z][a-z0-9_]{1,59}$/.test(id))
            throw new DocumentTemplateError(
              `A section needs data-clause="an_id" (lowercase) on line ${node.line}`,
            );
          if (found.has(id))
            throw new DocumentTemplateError(`Clause "${id}" appears twice (line ${node.line})`);
          found.set(id, {
            locked: Object.hasOwn(node.attrs, "data-locked"),
            content: canonical(node.children),
            title: node.attrs["data-title"] ?? null,
          });
        }
        visit(node.children);
      }
    };
    visit(this.nodes);
    return found;
  }

  layout(): LayoutBlock[] {
    const blocks: LayoutBlock[] = [];
    flow(this.nodes, blocks);
    return blocks;
  }
}

function parseNodes(source: string): MarkupNode[] {
  const root: { tag: string; attrs: Record<string, string>; children: MarkupNode[]; line: number } =
    {
      tag: "#root",
      attrs: {},
      children: [],
      line: 1,
    };
  const stack = [root];
  let at = 0;
  const lineAt = (i: number) => source.slice(0, i).split("\n").length;
  while (at < source.length) {
    const open = source.indexOf("<", at);
    const textEnd = open === -1 ? source.length : open;
    if (textEnd > at)
      stack.at(-1)!.children.push({ kind: "text", text: decode(source.slice(at, textEnd)) });
    if (open === -1) break;
    if (source.startsWith("<!--", open)) {
      const end = source.indexOf("-->", open);
      if (end === -1) throw new DocumentTemplateError(`Unclosed comment on line ${lineAt(open)}`);
      at = end + 3;
      continue;
    }
    TAG.lastIndex = open;
    const match = TAG.exec(source);
    const line = lineAt(open);
    if (match === null) throw new DocumentTemplateError(`Cannot read the tag on line ${line}`);
    const [whole, tag, rawAttrs, selfClosing] = match as unknown as [
      string,
      string,
      string,
      string,
    ];
    const allowed = ALLOWED[tag];
    if (allowed === undefined)
      throw new DocumentTemplateError(`<${tag}> is not allowed (line ${line})`);
    if (whole.startsWith("</")) {
      const current = stack.at(-1)!;
      if (current.tag !== tag)
        throw new DocumentTemplateError(
          current.tag === "#root"
            ? `</${tag}> closes nothing (line ${line})`
            : `</${tag}> on line ${line} should close <${current.tag}> from line ${current.line}`,
        );
      stack.pop();
      stack.at(-1)!.children.push({
        kind: "element",
        tag,
        attrs: current.attrs,
        children: current.children,
        line: current.line,
      });
    } else {
      const attrs: Record<string, string> = {};
      for (const [, name, value] of rawAttrs.matchAll(ATTR)) {
        if (!allowed.includes(name!))
          throw new DocumentTemplateError(`<${tag}> cannot have ${name} (line ${line})`);
        attrs[name!] = decode(value ?? "");
      }
      for (const cls of (attrs.class ?? "").split(/\s+/).filter((c) => c !== ""))
        if (!CLASSES.includes(cls))
          throw new DocumentTemplateError(`Unknown class "${cls}" on line ${line}`);
      if (VOID.has(tag) || selfClosing === "/")
        stack.at(-1)!.children.push({ kind: "element", tag, attrs, children: [], line });
      else stack.push({ tag, attrs, children: [], line });
    }
    at = open + whole.length;
  }
  if (stack.length > 1) {
    const open = stack.at(-1)!;
    throw new DocumentTemplateError(`<${open.tag}> on line ${open.line} is never closed`);
  }
  return root.children;
}

/** Content compared for locked clauses: tags, attributes and text with whitespace collapsed. */
function canonical(nodes: readonly MarkupNode[]): string {
  return nodes
    .map((n) =>
      n.kind === "text"
        ? n.text.replace(/\s+/g, " ")
        : `<${n.tag}${Object.entries(n.attrs)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => ` ${k}="${v}"`)
            .join("")}>${canonical(n.children)}</${n.tag}>`,
    )
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

function runs(nodes: readonly MarkupNode[], style: Omit<Run, "text"> = {}): Run[] {
  const out: Run[] = [];
  for (const node of nodes) {
    if (node.kind === "text") {
      const text = node.text.replace(/\s+/g, " ");
      if (text !== "") out.push({ text, ...style });
      continue;
    }
    if (node.tag === "br") {
      out.push({ text: "\n", ...style });
      continue;
    }
    const next =
      node.tag === "strong" || node.tag === "b"
        ? { ...style, bold: true }
        : node.tag === "em" || node.tag === "i"
          ? { ...style, italic: true }
          : node.tag === "u"
            ? { ...style, underline: true }
            : style;
    out.push(...runs(node.children, next));
  }
  // Trim the outer whitespace of the paragraph.
  if (out.length > 0) {
    out[0] = { ...out[0]!, text: out[0]!.text.replace(/^ /, "") };
    out[out.length - 1] = { ...out.at(-1)!, text: out.at(-1)!.text.replace(/ $/, "") };
  }
  return out.filter((r) => r.text !== "");
}

const plain = (nodes: readonly MarkupNode[]) =>
  runs(nodes)
    .map((r) => r.text)
    .join("")
    .trim();

const alignOf = (el: Element): Align => {
  const cls = (el.attrs.class ?? "").split(/\s+/);
  return cls.includes("center")
    ? "center"
    : cls.includes("right")
      ? "right"
      : cls.includes("justify")
        ? "justify"
        : "left";
};

const elements = (nodes: readonly MarkupNode[], tag?: string) =>
  nodes.filter((n): n is Element => n.kind === "element" && (tag === undefined || n.tag === tag));

function flow(nodes: readonly MarkupNode[], out: LayoutBlock[]): void {
  let loose: MarkupNode[] = [];
  const flush = () => {
    const r = runs(loose);
    if (r.length > 0) out.push({ kind: "paragraph", runs: r, align: "left", small: false });
    loose = [];
  };
  for (const node of nodes) {
    if (node.kind === "text" || INLINE.has(node.tag)) {
      loose.push(node);
      continue;
    }
    flush();
    switch (node.tag) {
      case "h1":
      case "h2":
      case "h3":
        out.push({
          kind: "heading",
          level: Number(node.tag.slice(1)) as 1 | 2 | 3,
          runs: runs(node.children),
          align: alignOf(node),
        });
        break;
      case "p": {
        const r = runs(node.children);
        if (r.length > 0)
          out.push({
            kind: "paragraph",
            runs: r,
            align: alignOf(node),
            small: (node.attrs.class ?? "").includes("small"),
          });
        break;
      }
      case "ul":
      case "ol":
        out.push({
          kind: "list",
          ordered: node.tag === "ol",
          items: elements(node.children, "li").map((li) => runs(li.children)),
        });
        break;
      case "table": {
        const rows = [
          ...elements(node.children, "tr"),
          ...elements(node.children)
            .filter((e) => e.tag === "thead" || e.tag === "tbody")
            .flatMap((e) => elements(e.children, "tr")),
        ];
        const cells = rows.map((tr) =>
          elements(tr.children).filter((c) => c.tag === "td" || c.tag === "th"),
        );
        const headerRow = cells[0]?.length !== undefined && cells[0].every((c) => c.tag === "th");
        const columns = Math.max(0, ...cells.map((c) => c.length));
        if (columns === 0) break;
        const declared = (cells[0] ?? []).map((c) => Number(c.attrs["data-width"] ?? "0"));
        const given = declared.reduce((a, b) => a + (b > 0 ? b : 0), 0);
        const free = declared.filter((w) => !(w > 0)).length + (columns - declared.length);
        const widths = Array.from({ length: columns }, (_, i) => {
          const w = declared[i] ?? 0;
          return w > 0
            ? w / Math.max(100, given)
            : Math.max(0, 100 - given) / 100 / Math.max(1, free);
        });
        const text = (row: readonly Element[]) =>
          Array.from({ length: columns }, (_, i) =>
            row[i] === undefined ? "" : plain(row[i].children),
          );
        out.push({
          kind: "table",
          header: headerRow ? text(cells[0]!) : null,
          rows: (headerRow ? cells.slice(1) : cells).map(text),
          widths,
        });
        break;
      }
      case "hr":
        out.push({ kind: "rule" });
        break;
      case "div":
        if ((node.attrs.class ?? "").includes("page-break")) out.push({ kind: "page_break" });
        else flow(node.children, out);
        break;
      case "section":
        if (node.attrs["data-title"] !== undefined)
          out.push({
            kind: "heading",
            level: 3,
            runs: [{ text: node.attrs["data-title"] }],
            align: "left",
          });
        flow(node.children, out);
        break;
      case "signature-block":
        out.push({
          kind: "signatures",
          signers: elements(node.children, "signer").map((s) => ({
            role: s.attrs.role ?? "",
            label: s.attrs.label ?? s.attrs.role ?? "",
            name: s.attrs.name ?? plain(s.children),
          })),
        });
        break;
      default:
        // li, tr, td … outside their container: keep the text.
        flow(node.children, out);
    }
  }
  flush();
}
