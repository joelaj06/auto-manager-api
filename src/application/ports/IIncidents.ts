import type {
  ClaimStatus,
  Incident,
  IncidentType,
  InsuranceClaim,
  OffenceStatus,
  TrafficOffence,
} from "../../domain/incidents/Incident.js";

export type IncidentFilter = Readonly<{
  branchIds: "all" | readonly string[];
  vehicleId?: string;
  driverId?: string;
  type?: IncidentType;
  status?: "open" | "closed";
  limit: number;
  beforeId?: string;
}>;

/** What an incident cost (minor units, base currency), from its work orders, expenses and claims. */
export type IncidentCosts = Readonly<{
  workOrders: readonly Readonly<{
    id: string;
    number: string;
    status: string;
    totalMinor: number;
    companyMinor: number;
    driverMinor: number;
    customerMinor: number;
    insurerMinor: number;
  }>[];
  expenses: readonly Readonly<{
    id: string;
    number: string | null;
    status: string;
    amountMinor: number;
    chargeToDriver: boolean;
  }>[];
}>;

export type OffenceFilter = Readonly<{
  branchIds: "all" | readonly string[];
  vehicleId?: string;
  driverId?: string;
  statuses?: readonly OffenceStatus[];
  limit: number;
  beforeId?: string;
}>;

export type FuelAnomalyRow = Readonly<{
  id: string;
  fuelLogId: string;
  vehicleId: string;
  branchId: string;
  driverId: string | null;
  kind: "low_efficiency" | "no_distance";
  kmPerLitre: number | null;
  baseline: number | null;
  litres: number;
  distance: number;
  status: "open" | "confirmed" | "dismissed";
  reviewedBy: string | null;
  reviewedAt: Date | null;
  note: string | null;
  createdAt: Date;
}>;

/** A driver as the incidents module needs them. */
export type DriverRef = Readonly<{ driverId: string; name: string; phone: string }>;

/** Incidents, insurance claims, traffic offences and fuel anomalies (tenant unit of work). */
export interface IIncidents {
  insert(incident: Incident): Promise<void>;
  update(incident: Incident): Promise<void>;
  get(id: string): Promise<Incident | null>;
  lock(id: string): Promise<Incident | null>;
  list(filter: IncidentFilter): Promise<Incident[]>;
  costs(incidentId: string): Promise<IncidentCosts>;
  /** Links an expense of the same vehicle (or none) to the incident; false: not found. */
  linkExpense(incidentId: string, expenseId: string, vehicleId: string): Promise<boolean>;
  /** Links a work order of the same vehicle; false: not found. */
  linkWorkOrder(incidentId: string, workOrderId: string, vehicleId: string): Promise<boolean>;

  insertClaim(claim: InsuranceClaim): Promise<void>;
  updateClaim(claim: InsuranceClaim): Promise<void>;
  lockClaim(id: string): Promise<InsuranceClaim | null>;
  claimsOf(incidentId: string): Promise<InsuranceClaim[]>;
  claims(
    filter: Readonly<{
      branchIds: "all" | readonly string[];
      statuses?: readonly ClaimStatus[];
      insurerId?: string;
      limit: number;
    }>,
  ): Promise<InsuranceClaim[]>;

  insertOffence(offence: TrafficOffence): Promise<void>;
  updateOffence(offence: TrafficOffence): Promise<void>;
  getOffence(id: string): Promise<TrafficOffence | null>;
  lockOffence(id: string): Promise<TrafficOffence | null>;
  offences(filter: OffenceFilter): Promise<TrafficOffence[]>;
  noticeTaken(authority: string, noticeRef: string, exceptId: string | null): Promise<boolean>;

  addAnomaly(row: FuelAnomalyRow): Promise<void>;
  lockAnomaly(id: string): Promise<FuelAnomalyRow | null>;
  updateAnomaly(row: FuelAnomalyRow): Promise<void>;
  anomalies(
    filter: Readonly<{
      branchIds: "all" | readonly string[];
      vehicleId?: string;
      status?: FuelAnomalyRow["status"];
      limit: number;
    }>,
  ): Promise<FuelAnomalyRow[]>;

  /** The driver who had the vehicle at that time (an assignment then), if any. */
  driverAt(vehicleId: string, at: Date): Promise<DriverRef | null>;
  driver(id: string): Promise<DriverRef | null>;
  /** An active supplier of the business. */
  supplierExists(id: string): Promise<boolean>;
}
