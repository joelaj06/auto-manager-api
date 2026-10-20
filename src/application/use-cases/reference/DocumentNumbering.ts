import { SequenceCode } from "../../../domain/value-objects/SequenceCode.js";
import type { IOrganisationSettings, NumberingFormat } from "../../ports/IOrganisationSettings.js";
import type { ISequenceGenerator } from "../../ports/ISequenceGenerator.js";

/** Formats used until the business sets its own (Settings → Numbering). */
export const DEFAULT_NUMBERING: Readonly<Record<string, NumberingFormat>> = Object.freeze({
  invoice: { prefix: "INV", padding: 6, yearly: true },
  receipt: { prefix: "RCT", padding: 6, yearly: true },
  payment: { prefix: "PAY", padding: 6, yearly: true },
  expense: { prefix: "EXP", padding: 6, yearly: true },
  remittance: { prefix: "RMT", padding: 6, yearly: true },
  rental: { prefix: "RNT", padding: 6, yearly: true },
  credit_note: { prefix: "CRN", padding: 6, yearly: true },
  journal: { prefix: "JRN", padding: 6, yearly: true },
  vehicle_issue: { prefix: "ISS", padding: 6, yearly: true },
  vehicle: { prefix: "VEH", padding: 5, yearly: false },
  driver: { prefix: "DRV", padding: 5, yearly: false },
  customer: { prefix: "CUS", padding: 5, yearly: false },
  supplier: { prefix: "SUP", padding: 4, yearly: false },
});

/**
 * Document numbers (INV-2026-000123): the business's format for the kind, with a gap-free
 * counter per kind (per year when the format restarts yearly). Call inside the unit of work that
 * creates the document, so a rollback gives the number back.
 */
export class DocumentNumbering {
  constructor(
    private readonly deps: Readonly<{
      organisation: IOrganisationSettings;
      sequences: ISequenceGenerator;
    }>,
  ) {}

  /** The formats in effect: the business's own over the defaults. */
  async formats(): Promise<Readonly<Record<string, NumberingFormat>>> {
    const { numbering } = await this.deps.organisation.get();
    return { ...DEFAULT_NUMBERING, ...numbering };
  }

  async next(kind: string, date: Date): Promise<string> {
    const format = (await this.formats())[kind];
    if (format === undefined) throw new Error(`No numbering format for "${kind}"`);
    const year = date.getUTCFullYear();
    const number = await this.deps.sequences.next(
      format.yearly ? `document:${kind}:${year}` : `document:${kind}`,
    );
    return SequenceCode.create({
      prefix: format.prefix,
      number,
      padding: format.padding,
      ...(format.yearly ? { year } : {}),
    }).toString();
  }
}
