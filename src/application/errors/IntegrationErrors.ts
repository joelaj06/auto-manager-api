import { ApplicationError } from "./ApplicationError.js";

export class EnterpriseLicenceRequiredError extends ApplicationError {
  readonly code = "ENTERPRISE_LICENCE_REQUIRED";
  constructor() {
    super("This is part of the Enterprise licence");
  }
}

export class ApiKeyNotFoundError extends ApplicationError {
  readonly code = "API_KEY_NOT_FOUND";
  constructor() {
    super("API key not found");
  }
}

export class WebhookNotFoundError extends ApplicationError {
  readonly code = "TENANT_WEBHOOK_NOT_FOUND";
  constructor() {
    super("Webhook not found");
  }
}

export class CustomDomainNotFoundError extends ApplicationError {
  readonly code = "CUSTOM_DOMAIN_NOT_FOUND";
  constructor() {
    super("Custom domain not found");
  }
}
