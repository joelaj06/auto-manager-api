import { DomainError } from "../errors/DomainError.js";

export class AppraisalRuleError extends DomainError {
  readonly code = "APPRAISAL_RULE";
  constructor(message: string) {
    super(message);
  }
}

export const APPRAISAL_STATUSES = ["open", "used", "declined"] as const;
export type AppraisalStatus = (typeof APPRAISAL_STATUSES)[number];
export const CONDITIONS = ["excellent", "good", "fair", "poor"] as const;
export type Condition = (typeof CONDITIONS)[number];

/** The vehicle offered in part exchange, as the appraiser found it. */
export type AppraisalDetails = Readonly<{
  make: string;
  model: string;
  year: number | null;
  plateNumber: string | null;
  vin: string | null;
  colour: string | null;
  mileage: number | null;
  condition: Condition;
  findings: string | null;
  valueMinor: number;
  validUntil: string;
}>;

export type AppraisalProps = AppraisalDetails &
  Readonly<{
    id: string;
    number: string;
    branchId: string;
    leadId: string | null;
    customerId: string | null;
    status: AppraisalStatus;
    appraisedBy: string;
    appraisedOn: string;
    dealId: string | null;
    vehicleId: string | null;
    declinedReason: string | null;
    createdAt: Date;
    updatedAt: Date;
  }>;

const MAX_MINOR = 1_000_000_000_00;

/**
 * A trade-in appraisal (docs/10 §7): the vehicle offered, its condition, mileage and findings,
 * a value held until a date and the appraiser. A deal takes it as part payment; at the sale it
 * becomes a stock vehicle at that value (decisions 445–452).
 */
export class Appraisal {
  private constructor(private props: AppraisalProps) {}

  static record(
    input: AppraisalDetails &
      Readonly<{
        id: string;
        number: string;
        branchId: string;
        leadId: string | null;
        customerId: string | null;
        appraisedBy: string;
        today: string;
        now: Date;
      }>,
  ): Appraisal {
    const { today, now, ...rest } = input;
    return new Appraisal({
      ...rest,
      ...check(input, today),
      status: "open",
      appraisedOn: today,
      dealId: null,
      vehicleId: null,
      declinedReason: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  static restore(props: AppraisalProps): Appraisal {
    return new Appraisal(props);
  }

  get id(): string {
    return this.props.id;
  }

  get status(): AppraisalStatus {
    return this.props.status;
  }

  snapshot(): AppraisalProps {
    return this.props;
  }

  revise(details: AppraisalDetails, today: string, now: Date): void {
    if (this.props.status !== "open") throw new AppraisalRuleError("The appraisal is closed");
    if (this.props.dealId !== null)
      throw new AppraisalRuleError("The appraisal is on a deal: take it off the deal first");
    this.props = { ...this.props, ...check(details, today), updatedAt: now };
  }

  /** Still usable on a deal today. */
  assertUsable(today: string, dealId: string): void {
    const p = this.props;
    if (p.status !== "open") throw new AppraisalRuleError("The appraisal is closed");
    if (p.dealId !== null && p.dealId !== dealId)
      throw new AppraisalRuleError("The appraisal is on another deal");
    if (p.validUntil < today)
      throw new AppraisalRuleError("The appraisal has run out: appraise the vehicle again");
  }

  attach(dealId: string, today: string, now: Date): void {
    this.assertUsable(today, dealId);
    this.props = { ...this.props, dealId, updatedAt: now };
  }

  detach(now: Date): void {
    if (this.props.status !== "open") return;
    this.props = { ...this.props, dealId: null, updatedAt: now };
  }

  /** Taken in at the sale: the stock vehicle it became. */
  use(vehicleId: string, now: Date): void {
    if (this.props.status !== "open" || this.props.dealId === null)
      throw new AppraisalRuleError("The appraisal is not on a deal");
    this.props = { ...this.props, status: "used", vehicleId, updatedAt: now };
  }

  decline(reason: string, now: Date): void {
    if (this.props.status !== "open") throw new AppraisalRuleError("The appraisal is closed");
    if (this.props.dealId !== null)
      throw new AppraisalRuleError("The appraisal is on a deal: take it off the deal first");
    const text = reason.trim();
    if (text.length < 3) throw new AppraisalRuleError("Say why the offer was declined");
    this.props = { ...this.props, status: "declined", declinedReason: text, updatedAt: now };
  }
}

function check(d: AppraisalDetails, today: string): AppraisalDetails {
  const make = d.make.trim();
  const model = d.model.trim();
  if (make === "" || model === "") throw new AppraisalRuleError("Give the make and model");
  if (!(Number.isSafeInteger(d.valueMinor) && d.valueMinor > 0 && d.valueMinor <= MAX_MINOR))
    throw new AppraisalRuleError("The value is above zero");
  if (d.mileage !== null && !(Number.isInteger(d.mileage) && d.mileage >= 0))
    throw new AppraisalRuleError("The mileage is zero or more");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.validUntil))
    throw new AppraisalRuleError("The validity date is YYYY-MM-DD");
  if (d.validUntil < today) throw new AppraisalRuleError("The value holds from today on");
  const clean = (v: string | null) => {
    const text = v?.trim() ?? "";
    return text === "" ? null : text;
  };
  return {
    ...d,
    make,
    model,
    plateNumber: clean(d.plateNumber)?.toUpperCase() ?? null,
    vin: clean(d.vin)?.toUpperCase() ?? null,
    colour: clean(d.colour),
    findings: clean(d.findings),
  };
}
