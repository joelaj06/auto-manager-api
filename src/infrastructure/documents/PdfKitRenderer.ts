import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import type {
  IPdfRenderer,
  PdfAlign,
  PdfBlock,
  PdfDocument,
  PdfRun,
} from "../../application/ports/IPdfRenderer.js";

const MARGIN = 50;
const INK = "#1f2933";
const MUTED = "#6b7280";
const RULE = "#d1d5db";
const ACCENT = "#f3f4f6";

const isPng = (b: Uint8Array) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
const isJpeg = (b: Uint8Array) => b[0] === 0xff && b[1] === 0xd8;

/**
 * Renders documents to A4 PDF with PDFKit (no browser needed): letterhead with the logo, title
 * and reference, the content blocks, a watermark when given, and "page x of y" footers. Uses the
 * standard Helvetica fonts, so amounts are written with currency codes (GHS), not symbols.
 */
export class PdfKitRenderer implements IPdfRenderer {
  render(document: PdfDocument): Promise<Buffer> {
    const pdf = new PDFDocument({
      size: "A4",
      margins: { top: MARGIN, bottom: MARGIN + 20, left: MARGIN, right: MARGIN },
      bufferPages: true,
      info: {
        Title:
          document.reference === null ? document.title : `${document.title} ${document.reference}`,
        Author: document.issuer.name,
        Creator: "Autoforce Manager",
        CreationDate: document.createdAt,
        ModDate: document.createdAt,
      },
    });
    const chunks: Buffer[] = [];
    const done = new Promise<Buffer>((resolve, reject) => {
      pdf.on("data", (chunk: Buffer) => chunks.push(chunk));
      pdf.on("end", () => resolve(Buffer.concat(chunks)));
      pdf.on("error", reject);
    });

    this.letterhead(pdf, document);
    for (const block of document.blocks) this.block(pdf, block);
    this.finish(pdf, document);
    pdf.end();
    return done;
  }

  private get width() {
    return 595.28 - 2 * MARGIN;
  }

  private letterhead(pdf: PDFKit.PDFDocument, d: PdfDocument) {
    const top = MARGIN;
    let textLeft = MARGIN;
    const logo = d.issuer.logo;
    if (logo !== null && (isPng(logo) || isJpeg(logo))) {
      try {
        pdf.image(Buffer.from(logo), MARGIN, top, { fit: [64, 64] });
        textLeft = MARGIN + 76;
      } catch {
        // An unreadable logo never stops a receipt.
      }
    }
    pdf.fillColor(INK).font("Helvetica-Bold").fontSize(14);
    pdf.text(d.issuer.name, textLeft, top, { width: 260 });
    pdf.font("Helvetica").fontSize(9).fillColor(MUTED);
    for (const line of d.issuer.lines) pdf.text(line, textLeft, undefined, { width: 260 });
    const leftBottom = pdf.y;

    // A template brings its own title: the letterhead then shows only the reference.
    pdf.y = top;
    if (d.title !== "") {
      pdf.font("Helvetica-Bold").fontSize(20).fillColor(INK);
      pdf.text(d.title.toUpperCase(), MARGIN, top, { width: this.width, align: "right" });
    }
    if (d.reference !== null) {
      pdf.font("Helvetica").fontSize(10).fillColor(MUTED);
      pdf.text(d.reference, MARGIN, undefined, { width: this.width, align: "right" });
    }
    pdf.y = Math.max(leftBottom, pdf.y, top + 64) + 14;
    this.rule(pdf);
    pdf.moveDown(1);
  }

  private block(pdf: PDFKit.PDFDocument, block: PdfBlock) {
    const x = MARGIN;
    switch (block.type) {
      case "heading": {
        const size = { 1: 16, 2: 12.5, 3: 11 }[block.level ?? 3];
        // Keep a heading with the first lines of what follows it.
        this.room(pdf, 80);
        pdf.moveDown(block.level === 1 ? 0.2 : 0.6);
        pdf
          .font("Helvetica-Bold")
          .fontSize(size)
          .fillColor(INK)
          .text(block.text, x, undefined, { width: this.width, align: block.align ?? "left" });
        pdf.moveDown(0.3);
        return;
      }
      case "rich":
        this.room(pdf, 24);
        this.runs(
          pdf,
          block.runs,
          block.small === true ? 8.5 : 10,
          block.align ?? "left",
          x,
          this.width,
        );
        pdf.moveDown(0.5);
        return;
      case "list":
        block.items.forEach((item, i) => {
          this.room(pdf, 20);
          const y = pdf.y;
          pdf
            .font("Helvetica")
            .fontSize(10)
            .fillColor(INK)
            .text(block.ordered ? `${i + 1}.` : "•", x + 6, y, { width: 18, lineBreak: false });
          pdf.y = y;
          this.runs(pdf, item, 10, "left", x + 24, this.width - 24);
          pdf.moveDown(0.2);
        });
        pdf.moveDown(0.4);
        return;
      case "rule":
        pdf.moveDown(0.3);
        this.rule(pdf);
        pdf.moveDown(0.6);
        return;
      case "pageBreak":
        pdf.addPage();
        return;
      case "signatures": {
        const per = 2;
        const gap = 30;
        const width = (this.width - gap * (per - 1)) / per;
        for (let i = 0; i < block.signers.length; i += per) {
          this.room(pdf, 90);
          const y = pdf.y + 46;
          block.signers.slice(i, i + per).forEach((signer, j) => {
            const left = x + j * (width + gap);
            if (signer.image !== undefined && signer.image !== null) {
              try {
                pdf.image(Buffer.from(signer.image), left, y - 42, { fit: [width * 0.7, 40] });
              } catch {
                // An unreadable image leaves the line empty; the audit page still records it.
              }
            } else if (signer.typed !== undefined && signer.typed !== null) {
              pdf
                .font("Helvetica-Oblique")
                .fontSize(16)
                .fillColor(INK)
                .text(signer.typed, left, y - 22, { width, lineBreak: false });
            }
            pdf
              .moveTo(left, y)
              .lineTo(left + width, y)
              .lineWidth(0.8)
              .stroke(INK);
            pdf
              .font("Helvetica-Bold")
              .fontSize(9)
              .fillColor(INK)
              .text(signer.label, left, y + 5, { width });
            pdf
              .font("Helvetica")
              .fontSize(9)
              .fillColor(MUTED)
              .text(signer.name, left, undefined, { width });
            if (signer.note !== undefined && signer.note !== null)
              pdf
                .font("Helvetica")
                .fontSize(8)
                .fillColor(MUTED)
                .text(signer.note, left, undefined, { width });
            else pdf.text("Date: ____________________", left, undefined, { width });
          });
          pdf.y = y + 50;
        }
        return;
      }
      case "verification": {
        this.room(pdf, 90);
        pdf.moveDown(0.5);
        const y = pdf.y;
        const size = 72;
        this.qr(pdf, block.url, x, y, size);
        pdf
          .font("Helvetica-Bold")
          .fontSize(9)
          .fillColor(INK)
          .text("Check this document", x + size + 12, y + 8, { width: this.width - size - 12 });
        pdf
          .font("Helvetica")
          .fontSize(8.5)
          .fillColor(MUTED)
          .text(`Scan the code or open ${block.url}`, { width: this.width - size - 12 });
        pdf
          .font("Helvetica-Bold")
          .fontSize(11)
          .fillColor(INK)
          .text(`Verification code ${block.code}`, { width: this.width - size - 12 });
        pdf.y = y + size + 10;
        return;
      }
      case "paragraph":
        pdf
          .font("Helvetica")
          .fontSize(block.muted === true ? 8.5 : 10)
          .fillColor(block.muted === true ? MUTED : INK)
          .text(block.text, x, undefined, { width: this.width });
        pdf.moveDown(0.5);
        return;
      case "fields": {
        const half = this.width / 2;
        for (let i = 0; i < block.rows.length; i += 2) {
          this.room(pdf, 30);
          const y = pdf.y;
          let bottom = y;
          for (const [column, row] of [block.rows[i], block.rows[i + 1]].entries()) {
            if (row === undefined) continue;
            const left = x + column * half;
            pdf
              .font("Helvetica")
              .fontSize(8)
              .fillColor(MUTED)
              .text(row.label.toUpperCase(), left, y, {
                width: half - 10,
              });
            pdf
              .font("Helvetica")
              .fontSize(10)
              .fillColor(INK)
              .text(row.value, left, undefined, {
                width: half - 10,
              });
            bottom = Math.max(bottom, pdf.y);
          }
          pdf.y = bottom + 6;
        }
        return;
      }
      case "amount": {
        this.room(pdf, 40);
        const y = pdf.y + 4;
        pdf.rect(x, y, this.width, 30).fill(ACCENT);
        pdf
          .font("Helvetica")
          .fontSize(10)
          .fillColor(MUTED)
          .text(block.label, x + 10, y + 10);
        pdf
          .font("Helvetica-Bold")
          .fontSize(14)
          .fillColor(INK)
          .text(block.value, x, y + 8, { width: this.width - 10, align: "right" });
        pdf.y = y + 40;
        return;
      }
      case "table":
        this.table(pdf, block);
        return;
    }
  }

  private table(pdf: PDFKit.PDFDocument, t: Extract<PdfBlock, { type: "table" }>) {
    const widths = t.columns.map((c) => c.width * this.width);
    const row = (cells: readonly string[], bold: boolean, header = false) => {
      const font = () => pdf.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(header ? 8 : 9);
      font();
      const heights = cells.map((cell, i) => pdf.heightOfString(cell, { width: widths[i]! - 8 }));
      const height = Math.max(...heights, 10) + 8;
      if (pdf.y + height > pdf.page.height - MARGIN - 20) {
        pdf.addPage();
        if (!header && t.header !== false) {
          row(
            t.columns.map((c) => c.header.toUpperCase()),
            true,
            true,
          );
          font(); // the repeated header changed it
        }
      }
      const y = pdf.y;
      if (header) pdf.rect(MARGIN, y, this.width, height).fill(ACCENT);
      let left = MARGIN;
      cells.forEach((cell, i) => {
        pdf.fillColor(header ? MUTED : INK).text(cell, left + 4, y + 4, {
          width: widths[i]! - 8,
          align: t.columns[i]!.align ?? "left",
        });
        left += widths[i]!;
      });
      pdf.y = y + height;
      if (!header) {
        pdf
          .moveTo(MARGIN, pdf.y)
          .lineTo(MARGIN + this.width, pdf.y)
          .lineWidth(0.5)
          .stroke(RULE);
      }
    };
    this.room(pdf, 40);
    if (t.header !== false)
      row(
        t.columns.map((c) => c.header.toUpperCase()),
        true,
        true,
      );
    for (const cells of t.rows) row(cells, false);
    if (t.total !== undefined) row(t.total, true);
    pdf.moveDown(0.8);
  }

  private finish(pdf: PDFKit.PDFDocument, d: PdfDocument) {
    const range = pdf.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i += 1) {
      pdf.switchToPage(i);
      if (d.watermark !== undefined) {
        pdf.save();
        pdf.rotate(-35, { origin: [297, 420] });
        pdf.font("Helvetica-Bold").fontSize(90).fillColor("#dc2626").opacity(0.12);
        pdf.text(d.watermark, 0, 380, { width: 595.28, align: "center", lineBreak: false });
        pdf.restore();
        pdf.opacity(1);
      }
      // Writing inside the bottom margin would otherwise start a new page.
      pdf.page.margins.bottom = 0;
      const bottom = pdf.page.height - MARGIN;
      pdf.font("Helvetica").fontSize(7.5).fillColor(MUTED);
      pdf.text(d.footer, MARGIN, bottom, { width: this.width - 80, lineBreak: false });
      pdf.text(`Page ${i - range.start + 1} of ${range.count}`, MARGIN, bottom, {
        width: this.width,
        align: "right",
        lineBreak: false,
      });
    }
  }

  /** A paragraph of styled runs (bold, italic, underline) wrapped to `width`. */
  private runs(
    pdf: PDFKit.PDFDocument,
    runs: readonly PdfRun[],
    size: number,
    align: PdfAlign,
    x: number,
    width: number,
  ) {
    pdf.fontSize(size).fillColor(size < 10 ? MUTED : INK);
    if (runs.length === 0) return;
    runs.forEach((run, i) => {
      const font =
        run.bold === true && run.italic === true
          ? "Helvetica-BoldOblique"
          : run.bold === true
            ? "Helvetica-Bold"
            : run.italic === true
              ? "Helvetica-Oblique"
              : "Helvetica";
      const options = {
        width,
        align,
        underline: run.underline === true,
        continued: i < runs.length - 1,
      };
      pdf.font(font);
      if (i === 0) pdf.text(run.text, x, pdf.y, options);
      else pdf.text(run.text, options);
    });
  }

  /** A QR code drawn as squares (vector, sharp when printed). */
  private qr(pdf: PDFKit.PDFDocument, text: string, x: number, y: number, size: number) {
    const modules = QRCode.create(text, { errorCorrectionLevel: "M" }).modules;
    const count = modules.size;
    const cell = size / count;
    pdf.save().fillColor("#000000");
    for (let row = 0; row < count; row += 1)
      for (let col = 0; col < count; col += 1)
        if (modules.get(row, col)) pdf.rect(x + col * cell, y + row * cell, cell, cell);
    pdf.fill();
    pdf.restore();
  }

  private rule(pdf: PDFKit.PDFDocument) {
    pdf
      .moveTo(MARGIN, pdf.y)
      .lineTo(MARGIN + this.width, pdf.y)
      .lineWidth(1)
      .stroke(RULE);
  }

  /** Starts a new page when less than `height` points are left. */
  private room(pdf: PDFKit.PDFDocument, height: number) {
    if (pdf.y + height > pdf.page.height - MARGIN - 20) pdf.addPage();
  }
}
