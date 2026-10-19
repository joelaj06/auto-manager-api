import { DomainError } from "../errors/DomainError.js";

export const VEHICLE_STATUSES = [
  "incoming",
  "reconditioning",
  "available",
  "assigned",
  "in_maintenance",
  "for_sale",
  "reserved",
  "sold",
  "reserved_rental",
  "on_rent",
  "on_workpay",
  "transferred",
  "repossessed",
  "accident",
  "impounded",
  "stolen",
  "written_off",
  "retired",
  "scrapped",
] as const;

export type VehicleStatus = (typeof VEHICLE_STATUSES)[number];

/**
 * States only the owning module moves a vehicle into or out of (a rental checks a vehicle out,
 * an assignment assigns it, a deal sells it …), always with a reference to its record. Users
 * cannot set them by hand: that is how the old system got vehicles stuck "Rented" (H9).
 */
export const MODULE_STATUSES: ReadonlySet<VehicleStatus> = new Set<VehicleStatus>([
  "assigned",
  "reserved",
  "sold",
  "reserved_rental",
  "on_rent",
  "on_workpay",
  "transferred",
  "repossessed",
]);

/** The vehicle has left the business or the road for good. */
export const FINAL_STATUSES: ReadonlySet<VehicleStatus> = new Set<VehicleStatus>([
  "sold",
  "transferred",
  "scrapped",
]);

/** Gone from the fleet: sold, handed over, scrapped or written off (no longer counted). */
export const OFF_FLEET_STATUSES: ReadonlySet<VehicleStatus> = new Set<VehicleStatus>([
  ...FINAL_STATUSES,
  "written_off",
]);

/** Reachable from any state that is not final (docs/06 §3: "any → accident / impounded / stolen"). */
const INCIDENTS: readonly VehicleStatus[] = ["accident", "impounded", "stolen"];

/** The lifecycle (docs/06 §3). Incidents are added to every non-final state below. */
const TRANSITIONS: Readonly<Record<VehicleStatus, readonly VehicleStatus[]>> = {
  incoming: ["reconditioning", "available", "retired"],
  reconditioning: ["available", "for_sale", "in_maintenance", "retired"],
  available: [
    "assigned",
    "in_maintenance",
    "reconditioning",
    "for_sale",
    "reserved_rental",
    "on_rent",
    "on_workpay",
    "retired",
  ],
  assigned: ["available", "in_maintenance", "on_workpay"],
  in_maintenance: ["available", "reconditioning", "for_sale", "written_off", "retired"],
  for_sale: ["available", "reserved", "sold", "in_maintenance", "reconditioning", "retired"],
  reserved: ["for_sale", "sold"],
  sold: [],
  reserved_rental: ["available", "on_rent"],
  on_rent: ["available", "in_maintenance"],
  on_workpay: ["transferred", "repossessed", "available"],
  transferred: [],
  repossessed: ["reconditioning", "available", "in_maintenance", "for_sale"],
  accident: ["in_maintenance", "available", "written_off"],
  impounded: ["available", "in_maintenance", "written_off"],
  stolen: ["available", "in_maintenance", "written_off"],
  written_off: ["for_sale", "scrapped"],
  retired: ["available", "for_sale", "scrapped"],
  scrapped: [],
};

export class VehicleStatusError extends DomainError {
  readonly code = "VEHICLE_STATUS_TRANSITION";
  constructor(message: string) {
    super(message);
  }
}

export function isVehicleStatus(value: unknown): value is VehicleStatus {
  return typeof value === "string" && (VEHICLE_STATUSES as readonly string[]).includes(value);
}

/** Where a vehicle in `from` may go next (any origin). */
export function nextStatuses(from: VehicleStatus): VehicleStatus[] {
  if (FINAL_STATUSES.has(from)) return [];
  const incidents = INCIDENTS.filter((s) => s !== from && from !== "written_off");
  return [...new Set([...TRANSITIONS[from], ...incidents])];
}

/**
 * Where a user may move a vehicle in `from` by hand: never into or out of a module's state
 * (except reporting an incident, which any state allows).
 */
export function manualNextStatuses(from: VehicleStatus): VehicleStatus[] {
  return nextStatuses(from).filter(
    (to) => INCIDENTS.includes(to) || (!MODULE_STATUSES.has(to) && !MODULE_STATUSES.has(from)),
  );
}

/** The states a new vehicle can start in (bought and on the way, being prepared, or ready). */
export const INITIAL_STATUSES: readonly VehicleStatus[] = [
  "incoming",
  "reconditioning",
  "available",
  "in_maintenance",
  "for_sale",
];
