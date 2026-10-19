import type { TaxCodeProps } from "../../domain/tax/TaxCode.js";

export type VehicleMake = Readonly<{ id: string; name: string; active: boolean }>;
export type VehicleModel = Readonly<{ id: string; makeId: string; name: string; active: boolean }>;

/**
 * Platform reference data (docs/27 §3.11), maintained by staff and read by every tenant: vehicle
 * makes and models. (Tax codes belong to each business, decision 100.)
 */
export interface IReferenceData {
  vehicleMakes(query: Readonly<{ q?: string; includeInactive?: boolean }>): Promise<VehicleMake[]>;
  vehicleMake(id: string): Promise<VehicleMake | null>;
  vehicleModels(makeId: string, includeInactive?: boolean): Promise<VehicleModel[]>;
  addVehicleMake(name: string): Promise<VehicleMake>;
  addVehicleModel(makeId: string, name: string): Promise<VehicleModel>;
  vehicleMakeNameTaken(name: string): Promise<boolean>;
  vehicleModelNameTaken(makeId: string, name: string): Promise<boolean>;
}

export type FxRate = Readonly<{
  id: string;
  base: string;
  quote: string;
  /** 1 quote = rate base, as a decimal string. */
  rate: string;
  rateDate: string;
  source: "manual" | "provider";
  enteredBy: string | null;
  createdAt: Date;
}>;

export type ExpenseCategory = Readonly<{
  id: string;
  parentId: string | null;
  code: string;
  name: string;
  isSystem: boolean;
  active: boolean;
  sort: number;
  /** Where its expenses are posted (null: vehicle or other expenses). */
  ledgerAccountId: string | null;
}>;

/** The tenant's own reference data (tenant database, tenant unit of work). */
export interface ITenantReferenceData {
  taxCodes(): Promise<TaxCodeProps[]>;
  taxCode(code: string): Promise<TaxCodeProps | null>;
  /** Inserts or updates the code with its components. */
  saveTaxCode(props: TaxCodeProps): Promise<void>;

  fxRates(filter: Readonly<{ quote?: string; limit: number }>): Promise<FxRate[]>;
  /** The latest rate for `quote` on or before `date`. */
  latestFxRate(base: string, quote: string, date: string): Promise<FxRate | null>;
  addFxRate(rate: Omit<FxRate, "createdAt">): Promise<void>;
  fxRateExists(base: string, quote: string, date: string): Promise<boolean>;
  removeFxRate(id: string): Promise<boolean>;

  expenseCategories(): Promise<ExpenseCategory[]>;
  expenseCategory(id: string): Promise<ExpenseCategory | null>;
  expenseCategoryCodeTaken(code: string): Promise<boolean>;
  saveExpenseCategory(category: ExpenseCategory): Promise<void>;
}
