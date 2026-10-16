export type ApplicationEventType =
  | "submitted"
  | "verified"
  | "info_requested"
  | "applicant_replied"
  | "approved"
  | "rejected"
  | "assigned"
  | "note";

export type ApplicationEvent = Readonly<{
  id: string;
  applicationId: string;
  type: ApplicationEventType;
  actorType: "applicant" | "platform_staff" | "system";
  actorId: string | null;
  /** Message exchanged with the applicant (or an internal note). */
  message: string | null;
  /** Internal events are never shown to the applicant. */
  internal: boolean;
  details: Readonly<Record<string, unknown>>;
  createdAt: Date;
}>;

/** Append-only timeline of an application. */
export interface IApplicationEvents {
  append(event: Omit<ApplicationEvent, "id" | "createdAt">): Promise<void>;
  list(applicationId: string, includeInternal: boolean): Promise<ApplicationEvent[]>;
}
