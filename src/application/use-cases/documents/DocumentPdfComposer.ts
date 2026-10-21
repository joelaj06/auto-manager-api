import { DocumentMarkup } from "../../../domain/documents/DocumentMarkup.js";
import type { DocumentSignerProps } from "../../../domain/documents/DocumentSigner.js";
import { groupCode, type IssuedDocumentProps } from "../../../domain/documents/IssuedDocument.js";
import { Template } from "../../../domain/documents/TemplateEngine.js";
import type { IOrganisationSettings } from "../../ports/IOrganisationSettings.js";
import type { IPdfRenderer, PdfBlock } from "../../ports/IPdfRenderer.js";
import type { BusinessLogo } from "../../services/BusinessLogo.js";
import { toPdfBlocks } from "./documentPdf.js";

/** A signer as the signed copy shows them, with their drawn signature's bytes. */
export type SignedBy = DocumentSignerProps & Readonly<{ image: Uint8Array | null }>;

const METHODS: Readonly<Record<string, string>> = {
  drawn: "Drawn signature",
  typed: "Typed name",
  paper: "Signed on paper (scan kept)",
};

/** "+233241234567" → "+233 24 *** 4567": enough to recognise, not to reuse. */
export const maskPhone = (phone: string) =>
  phone.length < 8 ? "***" : `${phone.slice(0, 6)} *** ${phone.slice(-4)}`;

/**
 * Turns an issued document into its PDF (docs/24 §3, §6): the template it was issued with and
 * its data snapshot, the letterhead and the verification QR. The signed copy adds each
 * signature on its line and a signature record page — who signed, how, when, from where, the
 * code they confirmed and the hash of the document they saw.
 */
export class DocumentPdfComposer {
  constructor(
    private readonly deps: Readonly<{
      organisation: IOrganisationSettings;
      renderer: IPdfRenderer;
      logo: BusinessLogo;
    }>,
  ) {}

  async compose(
    d: IssuedDocumentProps,
    verifyUrl: string,
    signed: Readonly<{ signers: readonly SignedBy[]; at: Date }> | null,
  ): Promise<Buffer> {
    const { deps } = this;
    const organisation = await deps.organisation.get();
    const issuer = (d.data.issuer ?? {}) as {
      name?: string;
      tin?: string | null;
      phone?: string | null;
      email?: string | null;
      address?: string | null;
    };
    const layout = DocumentMarkup.parse(Template.compile(d.templateBody).render(d.data)).layout();
    const zone = organisation.timezone;
    // toPdfBlocks maps block for block, so the layout gives each line's signer role.
    const blocks: PdfBlock[] = toPdfBlocks(layout).map((block, k) => {
      const source = layout[k];
      if (block.type !== "signatures" || source?.kind !== "signatures" || signed === null)
        return block;
      const byRole = new Map(signed.signers.map((s) => [s.role, s]));
      return {
        ...block,
        signers: block.signers.map((line, i) => {
          const s = byRole.get(source.signers[i]?.role ?? "");
          if (s === undefined || s.status !== "signed") return line;
          return {
            ...line,
            name: s.name,
            image: s.method === "drawn" ? s.image : null,
            typed: s.method === "typed" ? s.typedName : null,
            note:
              s.method === "paper"
                ? `Signed on paper, recorded ${localTime(s.signedAt!, zone)}`
                : `Signed electronically ${localTime(s.signedAt!, zone)}`,
          };
        }),
      };
    });
    const code = groupCode(d.verificationCode);
    blocks.push({ type: "verification", url: verifyUrl, code });
    if (signed !== null) blocks.push(...this.record(d, signed, zone));
    return deps.renderer.render({
      title: "",
      reference: d.number,
      issuer: {
        name: issuer.name ?? organisation.name,
        lines: [
          ...(issuer.tin ? [`TIN ${issuer.tin}`] : []),
          ...(issuer.phone ? [issuer.phone] : []),
          ...(issuer.email ? [issuer.email] : []),
          ...(issuer.address ? [issuer.address] : []),
        ],
        logo: await deps.logo.bytes(organisation.logoStorageKey),
      },
      blocks,
      footer: `${d.number} · verification code ${code}${signed === null ? "" : " · signed copy"}`,
      createdAt: signed?.at ?? d.issuedAt,
    });
  }

  /** The signature record page of the signed copy. */
  private record(
    d: IssuedDocumentProps,
    signed: Readonly<{ signers: readonly SignedBy[]; at: Date }>,
    zone: string,
  ): PdfBlock[] {
    return [
      { type: "pageBreak" },
      { type: "heading", level: 2, text: "Signature record" },
      {
        type: "rich",
        runs: [
          {
            text: `This page records how ${d.number} was signed in Autoforce Manager. Every signer had the same document in front of them — the PDF with SHA-256 `,
          },
          { text: d.pdfSha256 ?? "", bold: true },
          {
            text: ` — and confirmed: "${signed.signers.find((s) => s.consentText !== null)?.consentText ?? ""}"`,
          },
        ],
        small: true,
      },
      {
        type: "fields",
        rows: [
          { label: "Document", value: d.number },
          { label: "Verification code", value: groupCode(d.verificationCode) },
          { label: "Issued", value: localTime(d.issuedAt, zone) },
          { label: "Fully signed", value: localTime(signed.at, zone) },
        ],
      },
      {
        type: "table",
        columns: [
          { header: "Signer", width: 0.24 },
          { header: "Method", width: 0.18 },
          { header: "Signed", width: 0.2 },
          { header: "Identity check", width: 0.2 },
          { header: "From", width: 0.18 },
        ],
        rows: signed.signers
          .filter((s) => s.status === "signed")
          .map((s) => [
            `${s.name} (${s.label})`,
            METHODS[s.method ?? ""] ?? "",
            localTime(s.signedAt!, zone),
            s.method === "paper"
              ? "Scan checked by staff"
              : s.otpVerifiedAt === null
                ? "Signed in to their account"
                : `Code by ${s.otpChannel === "email" ? `email to ${s.email ?? ""}` : `SMS to ${maskPhone(s.phone ?? "")}`}`,
            [s.ip, deviceOf(s.userAgent)].filter((v) => v !== null && v !== "").join(", "),
          ]),
      },
    ];
  }
}

/** "21 October 2026, 14:05 (Africa/Accra)". */
export function localTime(at: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      day: "numeric",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return `${parts.day} ${parts.month} ${parts.year}, ${parts.hour}:${parts.minute} (${timeZone})`;
}

/** A short device description from a user agent ("Android", "iPhone", "Windows" …). */
function deviceOf(userAgent: string | null): string | null {
  if (userAgent === null) return null;
  for (const [needle, name] of [
    ["Android", "Android"],
    ["iPhone", "iPhone"],
    ["iPad", "iPad"],
    ["Windows", "Windows"],
    ["Macintosh", "Mac"],
    ["Linux", "Linux"],
  ] as const)
    if (userAgent.includes(needle)) return name;
  return userAgent.slice(0, 40);
}
