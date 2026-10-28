import { DomainError } from "../errors/DomainError.js";

export class PurchaseRuleError extends DomainError {
  readonly code = "PURCHASE_RULE";
  constructor(message: string) {
    super(message);
  }
}

export const PURCHASE_TYPES = ["local", "import", "auction"] as const;
export type PurchaseType = (typeof PURCHASE_TYPES)[number];

export const PURCHASE_STATUSES = ["draft", "ordered", "received", "cancelled"] as const;
export type PurchaseStatus = (typeof PURCHASE_STATUSES)[number];

/** The import timeline (docs/11 §4) up to the vehicles leaving the port; receiving ends it. */
export const IMPORT_STAGES = [
  "ordered",
  "paid",
  "picked_up",
  "at_origin_port",
  "shipped",
  "arrived_port",
  "under_clearing",
  "duty_paid",
  "released",
  "in_transit_local",
] as const;
export type ImportStage = (typeof IMPORT_STAGES)[number];

export type PurchaseLineDetails = Readonly<{
  vin: string | null;
  make: string;
  model: string;
  year: number | null;
  colour: string | null;
  description: string | null;
}>;

export type PurchaseLine = PurchaseLineDetails &
  Readonly<{
    id: string;
    position: number;
    /** The agreed price in the purchase's currency (becomes the line's vehicle price cost). */
    priceMinor: number;
    vehicleId: string | null;
    receivedAt: Date | null;
    receivedBy: string | null;
  }>;

export type Shipping = Readonly<{
  vessel: string | null;
  billOfLading: string | null;
  containerNumber: string | null;
  eta: string | null;
  /** Days at the port before demurrage is charged. */
  portFreeDays: number | null;
}>;

export type PurchaseDetails = Readonly<{
  type: PurchaseType;
  supplierId: string;
  branchId: string;
  currency: string;
  reference: string | null;
  expectedOn: string | null;
  notes: string | null;
}>;

export type PurchaseProps = PurchaseDetails &
  Shipping &
  Readonly<{
    id: string;
    number: string;
    status: PurchaseStatus;
    stage: ImportStage | null;
    lines: readonly PurchaseLine[];
    orderedOn: string | null;
    orderedBy: string | null;
    arrivedOn: string | null;
    releasedOn: string | null;
    receivedOn: string | null;
    cancelledAt: Date | null;
    cancelledBy: string | null;
    cancelReason: string | null;
    createdBy: string | null;
    createdAt: Date;
    updatedAt: Date;
  }>;

export type NewLine = PurchaseLineDetails & Readonly<{ id: string; priceMinor: number }>;

const MAX_LINES = 50;
const MAX_MINOR = 1_000_000_000_00;
const VIN = /^[A-HJ-NPR-Z0-9]{17}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const NO_SHIPPING: Shipping = {
  vessel: null,
  billOfLading: null,
  containerNumber: null,
  eta: null,
  portFreeDays: null,
};

/**
 * A vehicle purchase (docs/11 §3–6): drafted with one line per vehicle, ordered (each line's
 * price becomes a cost to the seller), for an import moved along the timeline, and received
 * line by line, each creating its vehicle; cancelled while nothing was received (decisions
 * 421–428).
 */
export class Purchase {
  private constructor(private props: PurchaseProps) {}

  static draft(
    input: PurchaseDetails &
      Readonly<{
        id: string;
        number: string;
        lines: readonly NewLine[];
        createdBy: string | null;
        now: Date;
      }>,
  ): Purchase {
    return new Purchase({
      ...checkDetails(input),
      ...NO_SHIPPING,
      id: input.id,
      number: input.number,
      status: "draft",
      stage: null,
      lines: checkLines(input.lines),
      orderedOn: null,
      orderedBy: null,
      arrivedOn: null,
      releasedOn: null,
      receivedOn: null,
      cancelledAt: null,
      cancelledBy: null,
      cancelReason: null,
      createdBy: input.createdBy,
      createdAt: input.now,
      updatedAt: input.now,
    });
  }

  static restore(props: PurchaseProps): Purchase {
    return new Purchase(props);
  }

  get id(): string {
    return this.props.id;
  }

  get status(): PurchaseStatus {
    return this.props.status;
  }

  snapshot(): PurchaseProps {
    return this.props;
  }

  /** Header and lines are edited while it is a draft. */
  revise(details: PurchaseDetails, lines: readonly NewLine[], now: Date): void {
    if (this.props.status !== "draft")
      throw new PurchaseRuleError("Only a draft purchase is edited; add costs instead");
    this.props = {
      ...this.props,
      ...checkDetails(details),
      lines: checkLines(lines),
      updatedAt: now,
    };
  }

  order(on: string, userId: string | null, now: Date): void {
    if (this.props.status !== "draft") throw new PurchaseRuleError("Only a draft is ordered");
    if (this.props.lines.length === 0) throw new PurchaseRuleError("Add the vehicles first");
    this.props = {
      ...this.props,
      status: "ordered",
      stage: this.props.type === "import" ? "ordered" : null,
      orderedOn: on,
      orderedBy: userId,
      updatedAt: now,
    };
  }

  /** An import moves forward along the timeline (stages may be skipped, never undone). */
  advance(stage: ImportStage, on: string, now: Date): void {
    const p = this.props;
    if (p.type !== "import") throw new PurchaseRuleError("Only an import has stages");
    if (p.status !== "ordered") throw new PurchaseRuleError("The purchase is not on its way");
    if (p.stage !== null && IMPORT_STAGES.indexOf(stage) <= IMPORT_STAGES.indexOf(p.stage))
      throw new PurchaseRuleError(`The import is already at ${p.stage.replaceAll("_", " ")}`);
    const index = IMPORT_STAGES.indexOf(stage);
    this.props = {
      ...p,
      stage,
      arrivedOn:
        index >= IMPORT_STAGES.indexOf("arrived_port") && p.arrivedOn === null ? on : p.arrivedOn,
      releasedOn:
        index >= IMPORT_STAGES.indexOf("released") && p.releasedOn === null ? on : p.releasedOn,
      updatedAt: now,
    };
  }

  setShipping(shipping: Shipping, now: Date): void {
    if (this.props.status === "received" || this.props.status === "cancelled")
      throw new PurchaseRuleError("The purchase is closed");
    if (shipping.eta !== null && !DATE.test(shipping.eta))
      throw new PurchaseRuleError("The ETA is YYYY-MM-DD");
    if (
      shipping.portFreeDays !== null &&
      !(shipping.portFreeDays >= 0 && shipping.portFreeDays <= 90)
    )
      throw new PurchaseRuleError("Free days at the port are 0 to 90");
    this.props = {
      ...this.props,
      vessel: clean(shipping.vessel),
      billOfLading: clean(shipping.billOfLading),
      containerNumber: clean(shipping.containerNumber),
      eta: shipping.eta,
      portFreeDays: shipping.portFreeDays,
      updatedAt: now,
    };
  }

  /** Corrects what is known of a vehicle (the VIN once the title arrives …) until it is received. */
  editLine(lineId: string, details: PurchaseLineDetails, now: Date): void {
    const line = this.line(lineId);
    if (line.vehicleId !== null) throw new PurchaseRuleError("That vehicle is already received");
    if (this.props.status === "cancelled") throw new PurchaseRuleError("The purchase is cancelled");
    this.props = {
      ...this.props,
      lines: this.props.lines.map((l) => (l.id === lineId ? { ...l, ...checkLine(details) } : l)),
      updatedAt: now,
    };
  }

  line(lineId: string): PurchaseLine {
    const line = this.props.lines.find((l) => l.id === lineId);
    if (line === undefined) throw new PurchaseRuleError("That line is not on this purchase");
    return line;
  }

  /** A line's vehicle has arrived and is registered; the last one closes the purchase. */
  receive(lineId: string, vehicleId: string, on: string, userId: string | null, now: Date): void {
    if (this.props.status !== "ordered") throw new PurchaseRuleError("Order the purchase first");
    if (this.line(lineId).vehicleId !== null)
      throw new PurchaseRuleError("That vehicle is already received");
    const lines = this.props.lines.map((l) =>
      l.id === lineId ? { ...l, vehicleId, receivedAt: now, receivedBy: userId } : l,
    );
    const done = lines.every((l) => l.vehicleId !== null);
    this.props = {
      ...this.props,
      lines,
      status: done ? "received" : "ordered",
      receivedOn: done ? on : null,
      updatedAt: now,
    };
  }

  cancel(reason: string, userId: string | null, now: Date): void {
    const p = this.props;
    if (p.status !== "draft" && p.status !== "ordered")
      throw new PurchaseRuleError("The purchase is closed");
    if (p.lines.some((l) => l.vehicleId !== null))
      throw new PurchaseRuleError("A vehicle was received: the purchase stays");
    if (reason.trim().length < 3) throw new PurchaseRuleError("Give a reason");
    this.props = {
      ...p,
      status: "cancelled",
      cancelledAt: now,
      cancelledBy: userId,
      cancelReason: reason.trim(),
      updatedAt: now,
    };
  }

  /** Costs are added from ordering until the purchase is cancelled (late costs after receipt). */
  assertTakesCosts(): void {
    if (this.props.status === "draft") throw new PurchaseRuleError("Order the purchase first");
    if (this.props.status === "cancelled") throw new PurchaseRuleError("The purchase is cancelled");
  }
}

function checkDetails(d: PurchaseDetails): PurchaseDetails {
  if (d.expectedOn !== null && !DATE.test(d.expectedOn))
    throw new PurchaseRuleError("The expected date is YYYY-MM-DD");
  return { ...d, reference: clean(d.reference), notes: clean(d.notes) };
}

function checkLines(lines: readonly NewLine[]): PurchaseLine[] {
  if (lines.length > MAX_LINES)
    throw new PurchaseRuleError(`A purchase has at most ${MAX_LINES} vehicles`);
  const vins = new Set<string>();
  return lines.map((l, i) => {
    if (!Number.isSafeInteger(l.priceMinor) || l.priceMinor < 0 || l.priceMinor > MAX_MINOR)
      throw new PurchaseRuleError("A vehicle's price is zero or more");
    const details = checkLine(l);
    if (details.vin !== null) {
      if (vins.has(details.vin)) throw new PurchaseRuleError(`VIN ${details.vin} is listed twice`);
      vins.add(details.vin);
    }
    return {
      ...details,
      id: l.id,
      position: i + 1,
      priceMinor: l.priceMinor,
      vehicleId: null,
      receivedAt: null,
      receivedBy: null,
    };
  });
}

function checkLine(l: PurchaseLineDetails): PurchaseLineDetails {
  const vin = clean(l.vin)?.toUpperCase() ?? null;
  if (vin !== null && !VIN.test(vin))
    throw new PurchaseRuleError("A VIN is 17 letters and digits (no I, O or Q)");
  if (l.make.trim() === "" || l.model.trim() === "")
    throw new PurchaseRuleError("Give each vehicle's make and model");
  if (l.year !== null && !(Number.isInteger(l.year) && l.year >= 1950 && l.year <= 2100))
    throw new PurchaseRuleError("The year is 1950 to 2100");
  return {
    vin,
    make: l.make.trim(),
    model: l.model.trim(),
    year: l.year,
    colour: clean(l.colour),
    description: clean(l.description),
  };
}

function clean(value: string | null): string | null {
  const text = value?.trim() ?? "";
  return text === "" ? null : text;
}
