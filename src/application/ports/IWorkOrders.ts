import type {
  WorkOrder,
  WorkOrderStatus,
  WorkOrderType,
} from "../../domain/maintenance/WorkOrder.js";

export type WorkOrderFilter = Readonly<{
  branchIds: "all" | readonly string[];
  branchId?: string;
  vehicleId?: string;
  vendorId?: string;
  statuses?: readonly WorkOrderStatus[];
  types?: readonly WorkOrderType[];
  limit: number;
  /** Newest first: rows with a smaller id. */
  beforeId?: string;
}>;

/** How a vendor has done on completed work orders. */
export type VendorRecord = Readonly<{
  workOrders: number;
  open: number;
  completed: number;
  spentMinor: number;
  /** Days from opening to completion, on average. */
  averageTurnaroundDays: number | null;
  averageRating: number | null;
  ratings: number;
}>;

/** Work orders and their lines and allocations (tenant unit of work), docs/12 §3. */
export interface IWorkOrders {
  insert(order: WorkOrder): Promise<void>;
  /** Saves the work order with its lines and allocations replaced. */
  update(order: WorkOrder): Promise<void>;
  get(id: string): Promise<WorkOrder | null>;
  lock(id: string): Promise<WorkOrder | null>;
  list(filter: WorkOrderFilter): Promise<WorkOrder[]>;
  vendorRecord(vendorId: string): Promise<VendorRecord>;
  /** An active supplier, a user, a driver of the business. */
  exists(kind: "supplier" | "user" | "driver", id: string): Promise<boolean>;
  /** The renter of the booking a damage was found on (null: not from a rental). */
  damageRenter(damageId: string): Promise<string | null>;
}
