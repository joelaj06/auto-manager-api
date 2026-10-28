import type { Allocation, CostKind } from "../../domain/purchases/LandedCost.js";
import type {
  ImportStage,
  Purchase,
  PurchaseStatus,
  PurchaseType,
} from "../../domain/purchases/Purchase.js";

export type PurchaseFilter = Readonly<{
  branchIds: "all" | readonly string[];
  branchId?: string;
  supplierId?: string;
  statuses?: readonly PurchaseStatus[];
  types?: readonly PurchaseType[];
  limit: number;
  /** Newest first: rows created before this one. */
  beforeId?: string;
}>;

export type NewPurchaseCost = Readonly<{
  id: string;
  purchaseId: string;
  lineId: string | null;
  kind: CostKind;
  allocation: Allocation;
  description: string;
  supplierId: string;
  expenseId: string;
  createdBy: string | null;
}>;

/** A cost with the state of its expense (what it posted, whether it was paid). */
export type PurchaseCostRecord = NewPurchaseCost &
  Readonly<{
    supplierName: string;
    expenseNumber: string | null;
    expenseStatus: string;
    currency: string;
    fxRate: string;
    amountMinor: number;
    amountBaseMinor: number;
    netBaseMinor: number;
    createdAt: Date;
  }>;

export type PurchaseEvent = Readonly<{
  id: string;
  purchaseId: string;
  kind: "created" | "ordered" | "stage" | "note" | "received" | "cancelled";
  stage: ImportStage | null;
  occurredOn: string;
  note: string | null;
  details: Readonly<Record<string, string | number | null>>;
  recordedBy: string | null;
  recordedAt: Date;
}>;

/** An import shipped with its ETA passed, or at the port: what the daily alerts look at. */
export type ImportWatch = Readonly<{
  purchaseId: string;
  number: string;
  branchId: string;
  supplierName: string;
  stage: ImportStage;
  eta: string | null;
  arrivedOn: string | null;
  portFreeDays: number | null;
}>;

/** Purchases, their lines, costs and timeline (tenant unit of work), docs/11. */
export interface IPurchases {
  insert(purchase: Purchase): Promise<void>;
  /** Saves the purchase with its lines replaced (received lines keep their vehicle). */
  update(purchase: Purchase): Promise<void>;
  get(id: string): Promise<Purchase | null>;
  lock(id: string): Promise<Purchase | null>;
  list(filter: PurchaseFilter): Promise<Purchase[]>;
  addCost(cost: NewPurchaseCost): Promise<void>;
  costs(purchaseId: string): Promise<PurchaseCostRecord[]>;
  /** The purchase a cost (by its id, the expense's source) belongs to. */
  purchaseOfCost(costId: string): Promise<string | null>;
  addEvent(event: PurchaseEvent): Promise<void>;
  events(purchaseId: string): Promise<PurchaseEvent[]>;
  /** Imports shipped or at the port and not yet released (cancelled and received left out). */
  importsUnderWay(): Promise<ImportWatch[]>;
  supplierExists(id: string): Promise<boolean>;
  supplierName(id: string): Promise<string>;
}
