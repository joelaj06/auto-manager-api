import type { Response } from "express";
import type { PdfFile } from "../../application/use-cases/documents/PrintedDocuments.js";

/** Sends a generated PDF to open in the browser (or save with its own name); never cached. */
export function sendPdf(res: Response, file: PdfFile): void {
  res
    .status(200)
    .set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${file.filename.replace(/[^A-Za-z0-9._-]/g, "_")}"`,
      "Cache-Control": "private, no-store",
      "Content-Length": String(file.content.length),
    })
    .end(file.content);
}
