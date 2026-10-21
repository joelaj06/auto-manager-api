import type { LayoutBlock } from "../../../domain/documents/DocumentMarkup.js";
import type { PdfBlock } from "../../ports/IPdfRenderer.js";

/** The layout of a rendered template as PDF blocks. */
export function toPdfBlocks(layout: readonly LayoutBlock[]): PdfBlock[] {
  return layout.map((block): PdfBlock => {
    switch (block.kind) {
      case "heading":
        return {
          type: "heading",
          level: block.level,
          align: block.align,
          text: block.runs.map((r) => r.text).join(""),
        };
      case "paragraph":
        return { type: "rich", runs: block.runs, align: block.align, small: block.small };
      case "list":
        return { type: "list", ordered: block.ordered, items: block.items };
      case "table":
        return {
          type: "table",
          header: block.header !== null,
          columns: block.widths.map((width, i) => ({
            header: block.header?.[i] ?? "",
            width,
          })),
          rows: block.rows,
        };
      case "rule":
        return { type: "rule" };
      case "page_break":
        return { type: "pageBreak" };
      case "signatures":
        return {
          type: "signatures",
          signers: block.signers.map((s) => ({ label: s.label, name: s.name })),
        };
    }
  });
}
