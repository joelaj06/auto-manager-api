import { ApplicationError } from "./ApplicationError.js";

export class DocumentNotFoundError extends ApplicationError {
  readonly code = "DOCUMENT_NOT_FOUND";
  constructor() {
    super("Document not found");
  }
}

export class DocumentTemplateNotFoundError extends ApplicationError {
  readonly code = "DOCUMENT_TEMPLATE_NOT_FOUND";
  constructor() {
    super("Template not found");
  }
}
