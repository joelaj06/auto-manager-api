import { describe, expect, it } from "vitest";
import { DocumentMarkup } from "./DocumentMarkup.js";
import { DOCUMENT_TYPE_CATALOG, DOCUMENT_TYPES } from "./DocumentTypes.js";
import { listOf, longDate, Template } from "./TemplateEngine.js";

const schema = {
  driver: { name: "text", joined: "date" },
  target: "money",
  missing: "text",
  items: listOf({ label: "text", ok: "boolean" }),
} as const;

describe("template language", () => {
  it("fills fields, formats them, escapes HTML and repeats lists", () => {
    const t = Template.compile(
      "<p>{{driver.name}} since {{date driver.joined}} owes {{money target}}</p>" +
        "{{#each items}}<li>{{@number}}. {{label}} {{ok}}</li>{{/each}}" +
        "{{#if missing}}never{{else}}fallback{{/if}}{{#unless items}}none{{/unless}}{{! note }}",
    );
    t.check(schema);
    expect(
      t.render({
        driver: { name: "Ama <script>", joined: "2026-03-05" },
        target: { amountMinor: 125_050, currency: "GHS" },
        items: [
          { label: "Jack", ok: true },
          { label: "Tyre", ok: false },
        ],
      }),
    ).toBe(
      "<p>Ama &lt;script&gt; since 5 March 2026 owes GHS 1,250.50</p>" +
        "<li>1. Jack Yes</li><li>2. Tyre No</li>fallback",
    );
  });

  it("refuses unknown fields, wrong formatters and broken blocks with their line", () => {
    const fails = (source: string) => () => Template.compile(source).check(schema);
    expect(fails("<p>\n{{driver.nmae}}</p>")).toThrow(/Unknown field "driver.nmae" on line 2/);
    expect(fails("{{target}}")).toThrow(/Write \{\{money target\}\}/);
    expect(fails("{{money driver.name}}")).toThrow(/does not fit/);
    expect(fails("{{#each driver}}x{{/each}}")).toThrow(/not a list/);
    expect(fails("{{#if target}}x")).toThrow(/never closed/);
    expect(fails("{{/each}}")).toThrow(/Unexpected/);
    expect(fails("{{{driver.name}}}")).toThrow(/Raw output/);
    expect(fails("{{shout driver.name}}")).toThrow(/Unknown formatter/);
    expect(fails("{{constructor.name}}")).toThrow(/Unknown field/);
  });

  it("never reads beyond the data it was given", () => {
    expect(Template.compile("{{constructor}}{{toString}}").render({})).toBe("");
    expect(longDate("2026-12-01T09:00:00Z")).toBe("1 December 2026");
  });
});

describe("document markup", () => {
  it("lays out headings, styled paragraphs, lists, tables and signatures", () => {
    const layout = DocumentMarkup.parse(
      `<h1 class="center">Title</h1>
       <p>Plain <strong>bold <em>both</em></strong> &amp; done</p>
       <ol><li>One</li><li>Two</li></ol>
       <table><tr><th data-width="25">A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>
       <hr/><div class="page-break"></div>
       <signature-block><signer role="owner" label="Owner" name="Ama"></signer></signature-block>`,
    ).layout();
    expect(layout.map((b) => b.kind)).toEqual([
      "heading",
      "paragraph",
      "list",
      "table",
      "rule",
      "page_break",
      "signatures",
    ]);
    expect(layout[1]).toMatchObject({
      runs: [
        { text: "Plain " },
        { text: "bold ", bold: true },
        { text: "both", bold: true, italic: true },
        { text: " & done" },
      ],
    });
    expect(layout[3]).toMatchObject({
      header: ["A", "B"],
      rows: [["1", "2"]],
      widths: [0.25, 0.75],
    });
  });

  it("refuses anything outside the safe subset", () => {
    expect(() => DocumentMarkup.parse("<script>x</script>")).toThrow(/<script> is not allowed/);
    expect(() => DocumentMarkup.parse('<p style="color:red">x</p>')).toThrow(/cannot have style/);
    expect(() => DocumentMarkup.parse("<p>x")).toThrow(/never closed/);
    expect(() => DocumentMarkup.parse("<p>x</h1>")).toThrow(/should close <p>/);
    expect(() => DocumentMarkup.parse('<p class="red">x</p>')).toThrow(/Unknown class/);
  });

  it("finds clauses and compares their content regardless of layout whitespace", () => {
    const a = DocumentMarkup.parse(
      '<section data-clause="ownership" data-locked><p>Owner keeps it.</p></section>',
    );
    const b = DocumentMarkup.parse(
      '<section data-locked data-clause="ownership">\n  <p>Owner   keeps it.</p>\n</section>',
    );
    expect(a.clauses().get("ownership")).toEqual(b.clauses().get("ownership"));
    expect(a.clauses().get("ownership")?.locked).toBe(true);
    expect(() =>
      DocumentMarkup.parse(
        '<section data-clause="xy"></section><section data-clause="xy"></section>',
      ).clauses(),
    ).toThrow(/appears twice/);
  });
});

describe("system templates", () => {
  it.each(DOCUMENT_TYPES)("%s compiles, fits its fields and renders its sample", (type) => {
    const def = DOCUMENT_TYPE_CATALOG[type];
    const template = Template.compile(def.system.body);
    template.check(def.fields);
    const markup = DocumentMarkup.parse(template.render(def.sample));
    expect(markup.layout().some((b) => b.kind === "signatures")).toBe(true);
    expect([...markup.clauses().values()].some((c) => c.locked)).toBe(true);
    expect(DocumentMarkup.parse(def.system.body).clauses().size).toBeGreaterThan(0);
  });
});
