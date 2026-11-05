import type { Paged, PageWindow } from "../../domain/value-objects/Paged.js";
export type WebhookEndpointRecord = Readonly<{
  id: string;
  url: string;
  description: string | null;
  events: readonly string[];
  status: "active" | "disabled";
  disabledReason: string | null;
  consecutiveFailures: number;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  createdAt: Date;
}>;

export type WebhookDeliveryRecord = Readonly<{
  id: string;
  endpointId: string;
  eventId: string;
  eventType: string;
  status: "pending" | "delivered" | "failed";
  attempts: number;
  nextAttemptAt: Date | null;
  lastStatus: number | null;
  lastError: string | null;
  deliveredAt: Date | null;
  createdAt: Date;
}>;

export type DeliveryToSend = WebhookDeliveryRecord &
  Readonly<{ body: string; url: string; sealedSecret: string; endpointStatus: string }>;

export type EndpointChanges = Readonly<{
  url?: string;
  description?: string | null;
  events?: readonly string[];
  status?: "active" | "disabled";
  disabledReason?: string | null;
}>;

export type AttemptOutcome = Readonly<{
  deliveryId: string;
  endpointId: string;
  delivered: boolean;
  httpStatus: number | null;
  error: string | null;
  /** When to try again; null: no more tries. */
  nextAttemptAt: Date | null;
  at: Date;
}>;

/** A business's webhook endpoints and what was sent to them (decisions 525–527). */
export interface IWebhooks {
  createEndpoint(
    endpoint: Readonly<{
      url: string;
      description: string | null;
      events: readonly string[];
      sealedSecret: string;
      createdBy: string;
    }>,
  ): Promise<string>;
  endpoint(id: string): Promise<WebhookEndpointRecord | null>;
  endpoints(): Promise<WebhookEndpointRecord[]>;
  countEndpoints(): Promise<number>;
  updateEndpoint(id: string, changes: EndpointChanges, now: Date): Promise<void>;
  setSecret(id: string, sealedSecret: string, now: Date): Promise<void>;
  removeEndpoint(id: string): Promise<void>;
  /** Whether any live endpoint wants this event: most changes have nobody listening. */
  hasSubscriber(eventType: string): Promise<boolean>;
  subscribers(eventType: string): Promise<string[]>;
  /** Null when this event was already queued for this endpoint. */
  createDelivery(
    delivery: Readonly<{
      endpointId: string;
      eventId: string;
      eventType: string;
      body: string;
      at: Date;
    }>,
  ): Promise<string | null>;
  delivery(id: string): Promise<DeliveryToSend | null>;
  deliveries(endpointId: string, window: PageWindow): Promise<Paged<WebhookDeliveryRecord>>;
  /** Records one try and returns the endpoint's failures in a row after it. */
  recordAttempt(outcome: AttemptOutcome): Promise<WebhookEndpointRecord | null>;
  replay(id: string, at: Date): Promise<boolean>;
  /** Deliveries whose job was lost: due long ago and still pending. */
  overdue(before: Date, limit: number): Promise<string[]>;
  purgeDeliveries(before: Date, limit: number): Promise<number>;
}

export type WebhookResponse = Readonly<{ status: number | null; error: string | null }>;

/** Posts to an address a tenant chose, refusing private networks at connection time. */
export interface IWebhookTransport {
  post(
    url: string,
    headers: Readonly<Record<string, string>>,
    body: string,
  ): Promise<WebhookResponse>;
}
