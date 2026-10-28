import type { MoveKind, Part, Stock } from "../../domain/maintenance/Part.js";

export type PartFilter = Readonly<{
  search?: string;
  category?: string;
  includeInactive: boolean;
  limit: number;
}>;

export type PartMove = Readonly<{
  id: string;
  partId: string;
  branchId: string;
  kind: MoveKind;
  quantity: number;
  unitCostMinor: number;
  valueMinor: number;
  onHandAfter: number;
  avgCostAfter: number;
  workOrderId: string | null;
  supplierId: string | null;
  expenseId: string | null;
  transferId: string | null;
  reference: string | null;
  reason: string | null;
  createdBy: string | null;
  createdAt: Date;
}>;

export type MoveFilter = Readonly<{
  branchIds: "all" | readonly string[];
  partId?: string;
  branchId?: string;
  workOrderId?: string;
  limit: number;
  /** Newest first: rows with a smaller id. */
  beforeId?: string;
}>;

/** A stock row with its part, for stock lists and reorder alerts. */
export type StockRow = Readonly<{
  stock: Stock;
  sku: string;
  name: string;
  unit: string;
  branchName: string;
}>;

/** The parts catalogue, stock per branch and stock moves (tenant unit of work), docs/12 §4. */
export interface IParts {
  insert(part: Part): Promise<void>;
  update(part: Part): Promise<void>;
  get(id: string): Promise<Part | null>;
  skuTaken(sku: string, exceptId: string | null): Promise<boolean>;
  list(filter: PartFilter): Promise<Part[]>;
  /** The part's stock at the branch, locked (an empty row the first time). */
  lockStock(partId: string, branchId: string): Promise<Stock>;
  saveStock(stock: Stock): Promise<void>;
  stockOf(partId: string, branchIds: "all" | readonly string[]): Promise<StockRow[]>;
  stock(
    filter: Readonly<{ branchIds: "all" | readonly string[]; branchId?: string; low?: boolean }>,
  ): Promise<StockRow[]>;
  /** Average unit cost at the branch (null: never stocked there). */
  costAt(partId: string, branchId: string): Promise<number | null>;
  addMove(move: PartMove): Promise<void>;
  /** An active supplier of the business. */
  supplierExists(id: string): Promise<boolean>;
  moves(filter: MoveFilter): Promise<PartMove[]>;
}
