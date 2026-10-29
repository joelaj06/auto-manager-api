import { DomainError } from "../errors/DomainError.js";

export class TestDriveRuleError extends DomainError {
  readonly code = "TEST_DRIVE_RULE";
  constructor(message: string) {
    super(message);
  }
}

export const TEST_DRIVE_STATUSES = ["booked", "out", "returned", "cancelled", "no_show"] as const;
export type TestDriveStatus = (typeof TEST_DRIVE_STATUSES)[number];

export type TestDriver = Readonly<{
  driverName: string;
  /** E.164, already parsed. */
  driverPhone: string;
  licenceNumber: string;
  licenceExpiresOn: string;
}>;

export type TestDriveProps = TestDriver &
  Readonly<{
    id: string;
    branchId: string;
    vehicleId: string;
    leadId: string | null;
    status: TestDriveStatus;
    startsAt: Date;
    endsAt: Date;
    accompaniedBy: string;
    blockId: string;
    odometerOut: number | null;
    odometerIn: number | null;
    wentOutAt: Date | null;
    cameBackAt: Date | null;
    waiverDocumentId: string | null;
    feedback: string | null;
    cancelReason: string | null;
    notes: string | null;
    createdBy: string | null;
    createdAt: Date;
    updatedAt: Date;
  }>;

const MAX_HOURS = 8;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A test drive (docs/10 §5): a slot on a stock vehicle (its block keeps rentals and other drives
 * off it), the driver's licence checked and still valid on the day, a member of staff along, a
 * waiver for signature and the odometer out and back (decisions 437–444).
 */
export class TestDrive {
  private constructor(private props: TestDriveProps) {}

  static book(
    input: TestDriver &
      Readonly<{
        id: string;
        branchId: string;
        vehicleId: string;
        leadId: string | null;
        startsAt: Date;
        endsAt: Date;
        accompaniedBy: string;
        blockId: string;
        notes: string | null;
        createdBy: string | null;
        now: Date;
      }>,
  ): TestDrive {
    checkWindow(input.startsAt, input.endsAt);
    const { now, ...rest } = input;
    return new TestDrive({
      ...rest,
      ...checkDriver(input),
      status: "booked",
      odometerOut: null,
      odometerIn: null,
      wentOutAt: null,
      cameBackAt: null,
      waiverDocumentId: null,
      feedback: null,
      cancelReason: null,
      notes: input.notes?.trim() || null,
      createdAt: now,
      updatedAt: now,
    });
  }

  static restore(props: TestDriveProps): TestDrive {
    return new TestDrive(props);
  }

  get id(): string {
    return this.props.id;
  }

  get status(): TestDriveStatus {
    return this.props.status;
  }

  snapshot(): TestDriveProps {
    return this.props;
  }

  /** The car leaves with the driver: the licence must still be valid today. */
  start(
    params: Readonly<{ odometer: number; today: string; waiverDocumentId: string | null }>,
    now: Date,
  ): void {
    if (this.props.status !== "booked") throw new TestDriveRuleError("The drive is not booked");
    if (this.props.licenceExpiresOn < params.today)
      throw new TestDriveRuleError("The driver's licence has expired");
    if (!Number.isInteger(params.odometer) || params.odometer < 0)
      throw new TestDriveRuleError("Read the odometer");
    this.props = {
      ...this.props,
      status: "out",
      odometerOut: params.odometer,
      wentOutAt: now,
      waiverDocumentId: params.waiverDocumentId,
      updatedAt: now,
    };
  }

  /** The car is back; returns the distance driven. */
  finish(odometer: number, feedback: string | null, now: Date): number {
    if (this.props.status !== "out") throw new TestDriveRuleError("The car is not out");
    const out = this.props.odometerOut!;
    if (!Number.isInteger(odometer) || odometer < out)
      throw new TestDriveRuleError(`The odometer reads at least ${out}`);
    this.props = {
      ...this.props,
      status: "returned",
      odometerIn: odometer,
      cameBackAt: now,
      feedback: feedback?.trim() || null,
      updatedAt: now,
    };
    return odometer - out;
  }

  /** Called off before it started, or the driver did not come (no_show). */
  cancel(status: "cancelled" | "no_show", reason: string | null, now: Date): void {
    if (this.props.status !== "booked") throw new TestDriveRuleError("The drive is not booked");
    const text = reason?.trim() ?? "";
    if (status === "cancelled" && text.length < 3) throw new TestDriveRuleError("Give a reason");
    this.props = {
      ...this.props,
      status,
      cancelReason: text === "" ? null : text,
      updatedAt: now,
    };
  }
}

function checkWindow(startsAt: Date, endsAt: Date): void {
  if (endsAt <= startsAt) throw new TestDriveRuleError("The drive ends after it starts");
  if (endsAt.getTime() - startsAt.getTime() > MAX_HOURS * 3_600_000)
    throw new TestDriveRuleError(`A test drive lasts at most ${MAX_HOURS} hours`);
}

function checkDriver(d: TestDriver): TestDriver {
  const driverName = d.driverName.trim();
  if (driverName === "") throw new TestDriveRuleError("Give the driver's name");
  const licenceNumber = d.licenceNumber.trim().toUpperCase();
  if (licenceNumber.length < 3) throw new TestDriveRuleError("Give the licence number");
  if (!DATE.test(d.licenceExpiresOn))
    throw new TestDriveRuleError("The licence expiry is YYYY-MM-DD");
  return { ...d, driverName, licenceNumber };
}
