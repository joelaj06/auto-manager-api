/** Documents still open in a currency, which keep it enabled (docs/20 §8, decision 413). */
export type OpenCurrencyDocuments = Readonly<{ invoices: number; expenses: number }>;

export interface ICurrencyUsage {
  /** Invoices drafted, issued or part paid and expenses not yet paid or voided in `currency`. */
  openDocuments(currency: string): Promise<OpenCurrencyDocuments>;
}
