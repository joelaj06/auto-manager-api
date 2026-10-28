import type { AlertStatus, DueStatus } from "../../domain/maintenance/ServiceDue.js";
import type {
  ServicePlanProps,
  ServicePlanWithTasks,
  ServiceTaskProps,
} from "../../domain/maintenance/ServicePlan.js";

/** A vehicle as the due engine sees it. */
export type ServiceVehicle = Readonly<{
  vehicleId: string;
  code: string;
  plateNumber: string | null;
  make: string;
  model: string;
  branchId: string;
  groupIds: readonly string[];
  classId: string | null;
  odometer: number | null;
  /** Sold, scrapped, written off … and removed vehicles are not serviced. */
  inService: boolean;
}>;

/** The stored due row of a vehicle's task. */
export type ServiceDueRow = Readonly<{
  id: string;
  vehicleId: string;
  taskId: string;
  planId: string;
  branchId: string;
  baseKm: number | null;
  baseOn: string;
  dueKm: number | null;
  dueOn: string | null;
  status: DueStatus;
  alerted: AlertStatus | null;
  computedAt: Date;
}>;

export type ServiceRecordProps = Readonly<{
  id: string;
  vehicleId: string;
  taskId: string;
  doneOn: string;
  odometer: number | null;
  note: string | null;
  workOrderRef: string | null;
  recordedBy: string | null;
  createdAt: Date;
}>;

/** A due row with the vehicle, plan and task names, for lists and alerts. */
export type ServiceDueView = ServiceDueRow &
  Readonly<{
    vehicleCode: string;
    plateNumber: string | null;
    make: string;
    model: string;
    odometer: number | null;
    planName: string;
    taskName: string;
  }>;

export type DueFilter = Readonly<{
  branchIds: "all" | readonly string[];
  branchId?: string;
  vehicleId?: string;
  statuses?: readonly DueStatus[];
  limit: number;
}>;

/** Who drives a vehicle now (its open assignment), to tell them a service is due. */
export type VehicleDriver = Readonly<{ driverId: string; name: string; phone: string }>;

/** Service plans, the due rows and service records (tenant unit of work), docs/12 §2. */
export interface IServicePlans {
  plans(includeInactive: boolean): Promise<ServicePlanWithTasks[]>;
  plan(id: string): Promise<ServicePlanWithTasks | null>;
  addPlan(plan: ServicePlanProps, createdBy: string): Promise<void>;
  updatePlan(plan: ServicePlanProps): Promise<void>;
  task(id: string): Promise<ServiceTaskProps | null>;
  addTask(task: ServiceTaskProps): Promise<void>;
  updateTask(task: ServiceTaskProps): Promise<void>;

  /** Vehicles (all when `ids` is null). */
  vehicles(ids: readonly string[] | null): Promise<ServiceVehicle[]>;
  /** The due rows, locked for the recompute. */
  dueRows(vehicleIds: readonly string[] | null): Promise<ServiceDueRow[]>;
  /** The latest service of each (vehicle, task) of these vehicles. */
  lastRecords(vehicleIds: readonly string[] | null): Promise<ServiceRecordProps[]>;
  saveDue(row: ServiceDueRow): Promise<void>;
  removeDue(ids: readonly string[]): Promise<void>;

  due(filter: DueFilter): Promise<ServiceDueView[]>;
  dueView(ids: readonly string[]): Promise<ServiceDueView[]>;
  addRecord(record: ServiceRecordProps): Promise<void>;
  records(vehicleId: string, limit: number): Promise<(ServiceRecordProps & { taskName: string })[]>;
  driverOf(vehicleId: string): Promise<VehicleDriver | null>;
  /** Does a group, class or vehicle exist (plan scopes)? */
  exists(kind: "group" | "class" | "vehicle", id: string): Promise<boolean>;
}
