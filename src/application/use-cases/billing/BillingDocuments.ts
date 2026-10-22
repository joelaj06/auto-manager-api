import type { BillingSettings } from "../../../domain/billing/BillingSettings.js";
import type { InvoiceParty, InvoiceProps } from "../../../domain/billing/Invoice.js";
import { Money } from "../../../domain/money/Money.js";
import type { PaymentRecord } from "../../../domain/repositories/IBillingRepository.js";
import type { IClock } from "../../ports/IClock.js";
import type { IPdfRenderer, PdfBlock } from "../../ports/IPdfRenderer.js";
import type { PdfFile } from "../documents/PrintedDocuments.js";

const METHODS: Readonly<Record<string, string>> = {
  bank_transfer: "Bank transfer",
  momo: "Mobile money",
  cash: "Cash",
  cheque: "Cheque",
  card: "Card",
  other: "Other",
};

const day = (d: Date) => d.toISOString().slice(0, 10);

const partyLines = (p: InvoiceParty | null): string[] =>
  p === null
    ? []
    : [
        ...(p.address === null ? [] : [p.address]),
        ...(p.tin === null ? [] : [`TIN ${p.tin}`]),
        ...(p.vatNumber === undefined || p.vatNumber === null ? [] : [`VAT ${p.vatNumber}`]),
        ...(p.email === undefined || p.email === null ? [] : [p.email]),
        ...(p.phone === undefined || p.phone === null ? [] : [p.phone]),
      ];

/**
 * PDFs of our own billing (docs/25 §6): the subscription invoice — lines, tax by levy, both
 * parties as issued, how to pay — and the receipt of a payment. Autoforce is the issuer.
 */
export class BillingDocuments {
  constructor(private readonly deps: Readonly<{ renderer: IPdfRenderer; clock: IClock }>) {}

  async invoice(
    i: InvoiceProps & Readonly<{ outstandingMinor: number }>,
    settings: BillingSettings,
  ): Promise<PdfFile> {
    const m = (minor: number) => Money.ofMinor(minor, i.currency).formatAscii();
    const blocks: PdfBlock[] = [
      {
        type: "fields",
        rows: [
          { label: "Billed to", value: i.buyer?.name ?? "" },
          ...partyLines(i.buyer).map((value) => ({ label: "", value })),
          { label: "Period", value: `${i.periodStart} to ${i.periodEnd}` },
          { label: "Issued", value: day(i.issuedAt) },
          { label: "Due", value: day(i.dueAt) },
          { label: "Status", value: i.status },
        ],
      },
      {
        type: "table",
        columns: [
          { header: "Description", width: 0.55 },
          { header: "Qty", width: 0.1, align: "right" },
          { header: "Unit price", width: 0.17, align: "right" },
          { header: "Amount", width: 0.18, align: "right" },
        ],
        rows: [
          ...i.lines.map((l) => [
            l.description,
            String(l.quantity),
            m(l.unitMinor),
            m(l.amountMinor),
          ]),
          ["Subtotal", "", "", m(i.subtotalMinor)],
          ...i.taxLines.map((t) => [`${t.name} ${t.rate}%`, "", "", m(t.amountMinor)]),
        ],
        total: ["Total", "", "", m(i.totalMinor)],
      },
      { type: "amount", label: "Amount due", value: m(i.outstandingMinor) },
      ...(i.taxLines.length === 0
        ? ([
            { type: "paragraph", muted: true, text: "No VAT is charged on this invoice." },
          ] as PdfBlock[])
        : []),
      ...(settings.paymentInstructions === null
        ? []
        : ([
            { type: "heading", text: "How to pay" },
            { type: "paragraph", text: settings.paymentInstructions },
          ] as PdfBlock[])),
      {
        type: "paragraph",
        muted: true,
        text: `Pay in the Billing tab of the web portal, quoting ${i.code} on any transfer.`,
      },
    ];
    return {
      filename: `${i.code}.pdf`,
      content: await this.render("Invoice", i.code, i.seller, settings, blocks, {
        watermark: i.status === "void" ? "VOID" : i.status === "paid" ? "PAID" : undefined,
      }),
    };
  }

  async receipt(
    p: PaymentRecord,
    invoice: InvoiceProps & Readonly<{ outstandingMinor: number }>,
    settings: BillingSettings,
  ): Promise<PdfFile> {
    const m = (minor: number) => Money.ofMinor(minor, p.currency).formatAscii();
    const reference = p.receiptNumber ?? p.id;
    const blocks: PdfBlock[] = [
      {
        type: "fields",
        rows: [
          { label: "Received from", value: invoice.buyer?.name ?? "" },
          { label: "Date", value: day(p.receivedAt) },
          { label: "Method", value: METHODS[p.method] ?? p.method },
          { label: "Reference", value: p.reference },
          {
            label: "For invoice",
            value: `${invoice.code} (${invoice.periodStart} to ${invoice.periodEnd})`,
          },
          { label: "Still due on the invoice", value: m(invoice.outstandingMinor) },
        ],
      },
      { type: "amount", label: "Amount received", value: m(p.amountMinor) },
    ];
    return {
      filename: `${reference}.pdf`,
      content: await this.render("Receipt", reference, invoice.seller, settings, blocks, {}),
    };
  }

  private render(
    title: string,
    reference: string,
    seller: InvoiceParty | null,
    settings: BillingSettings,
    blocks: readonly PdfBlock[],
    options: Readonly<{ watermark?: string | undefined }>,
  ): Promise<Buffer> {
    const issuer = seller ?? {
      name: settings.sellerName,
      address: settings.sellerAddress,
      tin: settings.sellerTin,
      vatNumber: settings.vatRegistered ? settings.vatNumber : null,
      email: settings.sellerEmail,
      phone: settings.sellerPhone,
    };
    return this.deps.renderer.render({
      title,
      reference,
      issuer: { name: issuer.name, lines: partyLines(issuer), logo: null },
      blocks,
      ...(options.watermark === undefined ? {} : { watermark: options.watermark }),
      footer: `${issuer.name} · ${title.toLowerCase()} ${reference}`,
      createdAt: this.deps.clock.now(),
    });
  }
}
