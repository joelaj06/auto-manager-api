/** An approved, unpaid expense: a bill the business owes (decision 416). */
export type OpenBill = Readonly<{
  expenseId: string;
  number: string | null;
  branchId: string;
  billDate: string;
  payee: Readonly<{ type: "supplier" | "driver"; id: string }> | null;
  payeeName: string;
  /** The supplier's payment terms (null: due at once). */
  termsDays: number | null;
  description: string;
  reference: string | null;
  currency: string;
  amountMinor: number;
  amountBaseMinor: number;
}>;

export interface IPayables {
  /** Open bills, oldest first; of one supplier when given; dated on or before `asOf`. */
  openBills(filter: Readonly<{ supplierId?: string; asOf: string }>): Promise<OpenBill[]>;
}
