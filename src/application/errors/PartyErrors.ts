import { ApplicationError } from "./ApplicationError.js";

export class DriverNotFoundError extends ApplicationError {
  readonly code = "DRIVER_NOT_FOUND";
  constructor() {
    super("Driver not found");
  }
}

export class CustomerNotFoundError extends ApplicationError {
  readonly code = "CUSTOMER_NOT_FOUND";
  constructor() {
    super("Customer not found");
  }
}

export class SupplierNotFoundError extends ApplicationError {
  readonly code = "SUPPLIER_NOT_FOUND";
  constructor() {
    super("Supplier not found");
  }
}

export class GuarantorNotFoundError extends ApplicationError {
  readonly code = "GUARANTOR_NOT_FOUND";
  constructor() {
    super("Guarantor not found");
  }
}

export class PartyDocumentNotFoundError extends ApplicationError {
  readonly code = "PARTY_DOCUMENT_NOT_FOUND";
  constructor() {
    super("Document not found");
  }
}

/** Another driver, customer or supplier already has this phone, email, card or name (409). */
export class PartyExistsError extends ApplicationError {
  readonly code = "PARTY_EXISTS";
  constructor(message: string) {
    super(message);
  }
}
