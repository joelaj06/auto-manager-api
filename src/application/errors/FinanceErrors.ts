import { ApplicationError } from "./ApplicationError.js";

export class InvoiceNotFoundError extends ApplicationError {
  readonly code = "INVOICE_NOT_FOUND";
  constructor() {
    super("Invoice not found");
  }
}

export class PaymentNotFoundError extends ApplicationError {
  readonly code = "PAYMENT_NOT_FOUND";
  constructor() {
    super("Payment not found");
  }
}

export class CashSessionNotFoundError extends ApplicationError {
  readonly code = "CASH_SESSION_NOT_FOUND";
  constructor(message = "Cash session not found") {
    super(message);
  }
}

/** The date falls in a locked period (docs/13 §7) — 409. */
export class PeriodLockedError extends ApplicationError {
  readonly code = "PERIOD_LOCKED";
  constructor(lockedUntil: string) {
    super(`The books are locked until ${lockedUntil}; use a later date`);
  }
}

/** A foreign-currency document needs an exchange rate for its date — 422. */
export class FxRateRequiredError extends ApplicationError {
  readonly code = "FX_RATE_REQUIRED";
  constructor(currency: string, date: string) {
    super(`Enter the ${currency} exchange rate for ${date} (or send fxRate)`);
  }
}

/** Changing the suggested exchange rate needs `finance.fx_rates.override` — 403. */
export class FxRateOverrideError extends ApplicationError {
  readonly code = "FX_RATE_OVERRIDE_DENIED";
  constructor(currency: string, suggested: string) {
    super(
      `The ${currency} rate for that date is ${suggested}; you may not change it (finance.fx_rates.override)`,
    );
  }
}

/** A cash payment needs the cashier's open cash session in that branch — 409. */
export class CashSessionRequiredError extends ApplicationError {
  readonly code = "CASH_SESSION_REQUIRED";
  constructor() {
    super("Open your cash session in this branch before recording cash");
  }
}
