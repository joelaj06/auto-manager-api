/** A booking as reminders and the board show it. */
export type RentalNoticeRow = Readonly<{
  bookingId: string;
  number: string;
  status: string;
  branchId: string;
  branchName: string;
  customerId: string;
  customerName: string;
  phone: string | null;
  email: string | null;
  vehicleId: string;
  vehicleCode: string;
  plateNumber: string | null;
  make: string;
  model: string;
  pickupAt: Date;
  returnAt: Date;
  checkedOutAt: Date | null;
  currency: string;
  /** All the booking's charges so far, with tax. */
  chargedMinor: number;
}>;

export type RentalReportFilter = Readonly<{
  branchIds: "all" | readonly string[];
  branchId: string | null;
}>;

export type Period = Readonly<{ from: Date; to: Date }>;

/** A vehicle of the rental fleet (with a rental class) and the hours it could be rented. */
export type FleetHoursRow = Readonly<{
  vehicleId: string;
  code: string;
  plateNumber: string | null;
  classId: string;
  className: string;
  branchId: string;
  /** Hours of the period the vehicle was on rent (check-out to return, or to now). */
  rentedSeconds: number;
  /** Hours of the period the vehicle was blocked for something else (maintenance …). */
  unavailableSeconds: number;
}>;

/** Booking charges of the period by branch, class and customer type (before tax). */
export type RevenueRow = Readonly<{
  branchId: string;
  branchName: string;
  classId: string | null;
  className: string | null;
  customerType: "individual" | "corporate";
  currency: string;
  bookings: number;
  /** All charges before tax (rental, extras, fees, damage …), credits taken off. */
  netMinor: number;
  /** The time charges (rental, changes, extensions, late return) before tax. */
  timeNetMinor: number;
}>;

/** What a booking still owes: open invoices, charges not invoiced, less money waiting. */
export type BalanceRow = Readonly<{
  bookingId: string;
  number: string;
  status: string;
  branchId: string;
  customerId: string;
  customerName: string;
  currency: string;
  invoicedOpenMinor: number;
  uninvoicedMinor: number;
  creditMinor: number;
  returnAt: Date;
}>;

export type DepositHeldRow = Readonly<{
  bookingId: string;
  number: string;
  status: string;
  branchId: string;
  customerName: string;
  currency: string;
  heldMinor: number;
  heldAt: Date;
}>;

export type DamageCostRow = Readonly<{
  damageId: string;
  vehicleId: string;
  plateNumber: string | null;
  branchId: string;
  bookingNumber: string | null;
  severity: string;
  status: string;
  liability: string;
  currency: string;
  /** The final cost when known, else the estimate (null: neither yet). */
  costMinor: number | null;
  /** The renter's damage charges on the booking. */
  chargedMinor: number;
  createdAt: Date;
}>;

/** Queries behind rental notifications and reports (tenant unit of work), docs/07 §10–11. */
export interface IRentalReporting {
  notice(bookingId: string): Promise<RentalNoticeRow | null>;
  /** Confirmed bookings picked up in [from, to). */
  pickupsBetween(from: Date, to: Date, filter?: RentalReportFilter): Promise<RentalNoticeRow[]>;
  /** Checked-out bookings due back in [from, to). */
  returnsBetween(from: Date, to: Date, filter?: RentalReportFilter): Promise<RentalNoticeRow[]>;
  /** Checked-out bookings due back before `before`. */
  overdue(before: Date, filter?: RentalReportFilter): Promise<RentalNoticeRow[]>;
  /** Reservations (not confirmed) lapsing in [from, to). */
  expiringBetween(from: Date, to: Date, filter: RentalReportFilter): Promise<RentalNoticeRow[]>;
  /** The rental fleet with its rented and blocked time over the period (until `now`). */
  fleetHours(period: Period, now: Date, filter: RentalReportFilter): Promise<FleetHoursRow[]>;
  revenue(period: Period, filter: RentalReportFilter): Promise<RevenueRow[]>;
  /** Bookings not cancelled that owe something. */
  balances(filter: RentalReportFilter): Promise<BalanceRow[]>;
  depositsHeld(filter: RentalReportFilter): Promise<DepositHeldRow[]>;
  /** Damages recorded in the period. */
  damages(period: Period, filter: RentalReportFilter): Promise<DamageCostRow[]>;
}
