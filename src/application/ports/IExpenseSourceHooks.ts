/**
 * Told when an expense raised by a module (its source) is posted or its posting is undone, so the
 * module can follow what it cost (a purchase's landed cost, decision 425).
 */
export interface IExpenseSourceHook {
  readonly sourceType: string;
  /** Inside the expense's unit of work, after the ledger changed. */
  postingChanged(sourceId: string): Promise<void>;
}
