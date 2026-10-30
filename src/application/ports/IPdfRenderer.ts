/**
 * A printable document described as content, not layout (docs/24 §3): the renderer owns fonts,
 * page size, letterhead and page numbers, so every PDF the system issues looks the same.
 */
/** Inline text with its style. */
export type PdfRun = Readonly<{
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
}>;
export type PdfAlign = "left" | "center" | "right" | "justify";

export type PdfBlock =
  | Readonly<{ type: "heading"; text: string; level?: 1 | 2 | 3; align?: PdfAlign }>
  | Readonly<{ type: "rich"; runs: readonly PdfRun[]; align?: PdfAlign; small?: boolean }>
  | Readonly<{ type: "list"; ordered: boolean; items: readonly (readonly PdfRun[])[] }>
  | Readonly<{ type: "rule" }>
  | Readonly<{ type: "pageBreak" }>
  /** Lines to sign on, with the signer's role and name under each. */
  | Readonly<{
      type: "signatures";
      signers: readonly Readonly<{
        label: string;
        name: string;
        /** PNG of a drawn signature, placed on the line. */
        image?: Uint8Array | null;
        /** Written on the line instead of an image (a typed signature). */
        typed?: string | null;
        /** Under the name: how and when it was signed. */
        note?: string | null;
      }>[];
    }>
  /** A QR code of `url` with the verification code beside it. */
  | Readonly<{ type: "verification"; url: string; code: string }>
  | Readonly<{ type: "paragraph"; text: string; muted?: boolean }>
  /** Label–value pairs in two columns. */
  | Readonly<{ type: "fields"; rows: readonly Readonly<{ label: string; value: string }>[] }>
  | Readonly<{
      type: "table";
      columns: readonly Readonly<{
        header: string;
        /** Share of the line width (the shares of a table add up to 1). */
        width: number;
        align?: "left" | "right";
      }>[];
      rows: readonly (readonly string[])[];
      /** A bold last row (totals). */
      total?: readonly string[];
      /** False: no header row (default true). */
      header?: boolean;
    }>
  /** A highlighted amount ("Amount received  GHS 250.00"). */
  | Readonly<{ type: "amount"; label: string; value: string }>;

export type PdfDocument = Readonly<{
  /** "Receipt", "Driver statement" … */
  title: string;
  /** The document number or period under the title. */
  reference: string | null;
  issuer: Readonly<{
    name: string;
    /** TIN, phone, email, branch … one per line. */
    lines: readonly string[];
    /** PNG or JPEG bytes of the business logo. */
    logo: Uint8Array | null;
  }>;
  /** A large diagonal word across each page ("REVERSED", "VOID"). */
  watermark?: string;
  /** Across the page (wide report tables); portrait by default. */
  landscape?: boolean;
  blocks: readonly PdfBlock[];
  /** Printed at the foot of every page. */
  footer: string;
  /** Fixed into the file so the same document renders to the same bytes. */
  createdAt: Date;
}>;

export interface IPdfRenderer {
  render(document: PdfDocument): Promise<Buffer>;
}
