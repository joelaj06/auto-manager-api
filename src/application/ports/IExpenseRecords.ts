import type { ExpenseProps, ExpenseStatus, PayeeType } from "../../domain/expenses/Expense.js";
import type { ApprovalRule, RecurringFrequency } from "../../domain/expenses/ExpenseRules.js";

export type ExpenseListFilter = Readonly<{
  /** Branches the caller may see ("all", a list) — or only what they created. */
  branchIds: "all" | readonly string[];
  createdBy?: string;
  branchId?: string;
  statuses?: readonly ExpenseStatus[];
  /** The category or any of its subcategories. */
  categoryId?: string;
  vehicleId?: string;
  driverId?: string;
  payee?: Readonly<{ type: PayeeType; id: string }>;
  from?: string;
  to?: string;
  limit: number;
  after?: Readonly<{ createdAt: string; id: string }>;
}>;

/** Reads over expenses (tenant unit of work). */
export interface IExpenseQueries {
  list(filter: ExpenseListFilter): Promise<ExpenseProps[]>;
  /** Expenses (not void) that look like a duplicate: same category, date, currency and amount. */
  similar(
    expense: Readonly<{
      id: string;
      categoryId: string;
      expenseDate: string;
      currency: string;
      amountMinor: number;
    }>,
  ): Promise<ExpenseProps[]>;
  /**
   * Approved and paid spending in a month (YYYY-MM) for a budget's filters (the category
   * includes its subcategories; a vehicle filter counts that vehicle's shares).
   */
  spent(
    filter: Readonly<{
      month: string;
      categoryId: string | null;
      branchId: string | null;
      vehicleId: string | null;
    }>,
  ): Promise<number>;
}

export interface IApprovalRules {
  list(): Promise<ApprovalRule[]>;
  get(id: string): Promise<ApprovalRule | null>;
  save(rule: ApprovalRule): Promise<void>;
}

export type Budget = Readonly<{
  id: string;
  name: string;
  categoryId: string | null;
  branchId: string | null;
  vehicleId: string | null;
  monthlyAmountMinor: number;
  active: boolean;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}>;

export interface IBudgets {
  list(): Promise<Budget[]>;
  get(id: string): Promise<Budget | null>;
  save(budget: Budget): Promise<void>;
  remove(id: string): Promise<void>;
}

export type RecurringExpense = Readonly<{
  id: string;
  name: string;
  categoryId: string;
  branchId: string;
  description: string;
  payee: Readonly<{ type: PayeeType; id: string }> | null;
  payeeName: string | null;
  amountMinor: number;
  taxCode: string | null;
  vehicleIds: readonly string[];
  frequency: RecurringFrequency;
  nextRunOn: string;
  endOn: string | null;
  autoSubmit: boolean;
  active: boolean;
  lastRunOn: string | null;
  createdBy: string | null;
  createdAt: Date;
  updatedAt: Date;
}>;

export interface IRecurringExpenses {
  list(): Promise<RecurringExpense[]>;
  get(id: string): Promise<RecurringExpense | null>;
  /** Active ones due on or before `date` (locked for update). */
  lockDue(date: string): Promise<RecurringExpense[]>;
  save(recurring: RecurringExpense): Promise<void>;
  remove(id: string): Promise<void>;
}

export type FuelLog = Readonly<{
  id: string;
  vehicleId: string;
  driverId: string | null;
  filledAt: Date;
  litres: number;
  amountMinor: number;
  odometer: number;
  fullTank: boolean;
  station: string | null;
  expenseId: string | null;
  notes: string | null;
  recordedBy: string | null;
  createdAt: Date;
}>;

export interface IFuelLogs {
  add(log: FuelLog): Promise<void>;
  /** Newest first. */
  forVehicle(vehicleId: string, limit: number): Promise<FuelLog[]>;
}

export type ExpenseSettings = Readonly<{
  /** Submitting needs a receipt scan above this amount (minor units; null: never). */
  receiptRequiredAboveMinor: number | null;
  /** Category code of fuel logs. */
  fuelCategoryCode: string;
  /** Category code of completed work orders' costs. */
  maintenanceCategoryCode: string;
}>;

export const DEFAULT_EXPENSE_SETTINGS: ExpenseSettings = Object.freeze({
  receiptRequiredAboveMinor: null,
  fuelCategoryCode: "fuel",
  maintenanceCategoryCode: "maintenance",
});

export interface IExpenseSettingsStore {
  get(): Promise<ExpenseSettings>;
  set(settings: ExpenseSettings): Promise<void>;
}
