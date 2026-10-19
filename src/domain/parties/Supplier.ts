import {
  checkPayout,
  normaliseTags,
  optionalEmail,
  optionalPhone,
  optionalText,
  requiredText,
  type PayoutDetails,
} from "./PartyDetails.js";

export const SUPPLIER_TYPES = [
  "dealer",
  "auction",
  "importer",
  "individual",
  "workshop",
  "parts",
  "fuel",
  "insurer",
  "clearing_agent",
  "other",
] as const;
export type SupplierType = (typeof SUPPLIER_TYPES)[number];

export type SupplierDetails = Readonly<{
  name: string;
  type: SupplierType;
  contactPerson: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  tin: string | null;
  paymentTermsDays: number | null;
  payout: PayoutDetails | null;
  active: boolean;
  tags: readonly string[];
  notes: string | null;
}>;

export type SupplierProps = SupplierDetails &
  Readonly<{
    id: string;
    code: string;
    createdBy: string | null;
    createdAt: Date;
    updatedAt: Date;
    deletedAt: Date | null;
    deletedReason: string | null;
  }>;

/**
 * A supplier (docs/05 §2.2): dealers, workshops, parts and fuel suppliers, insurers, clearing
 * agents … shared by every branch. Inactive suppliers stay on old records but are not offered
 * for new ones.
 */
export class Supplier {
  private constructor(private props: SupplierProps) {}

  static create(
    params: Readonly<{
      id: string;
      code: string;
      details: SupplierDetails;
      createdBy: string | null;
      now: Date;
    }>,
  ): Supplier {
    return new Supplier({
      ...normalise(params.details),
      id: params.id,
      code: params.code,
      createdBy: params.createdBy,
      createdAt: params.now,
      updatedAt: params.now,
      deletedAt: null,
      deletedReason: null,
    });
  }

  static restore(props: SupplierProps): Supplier {
    return new Supplier(props);
  }

  get id(): string {
    return this.props.id;
  }

  snapshot(): SupplierProps {
    return this.props;
  }

  update(changes: Partial<SupplierDetails>, now: Date): void {
    this.props = { ...this.props, ...normalise({ ...this.props, ...changes }), updatedAt: now };
  }

  remove(reason: string, now: Date): void {
    this.props = {
      ...this.props,
      deletedAt: now,
      deletedReason: requiredText(reason, "A reason", 500),
      updatedAt: now,
    };
  }
}

function normalise(d: SupplierDetails): SupplierDetails {
  return {
    ...d,
    name: requiredText(d.name, "Name", 160),
    contactPerson: optionalText(d.contactPerson, "Contact person", 120),
    phone: optionalPhone(d.phone),
    email: optionalEmail(d.email),
    address: optionalText(d.address, "Address", 300),
    tin: optionalText(d.tin, "TIN", 20)?.toUpperCase() ?? null,
    payout: checkPayout(d.payout),
    tags: normaliseTags(d.tags),
    notes: optionalText(d.notes, "Notes", 4_000),
  };
}
