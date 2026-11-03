import type {
  SlaTarget,
  SlaTargets,
  SupportTicket,
  SupportTicketProps,
  TicketCategory,
  TicketPriority,
  TicketStatus,
} from "../../domain/console/SupportDesk.js";

export type TicketMessage = Readonly<{
  id: string;
  ticketId: string;
  authorType: "staff" | "customer" | "system";
  authorStaffId: string | null;
  authorName: string;
  body: string;
  internal: boolean;
  cannedResponseId: string | null;
  createdAt: Date;
}>;

export type NewTicketMessage = Omit<TicketMessage, "id" | "createdAt">;

/** A ticket as staff and requesters read it. */
export type TicketView = Readonly<SupportTicketProps> &
  Readonly<{
    tenantSlug: string | null;
    tenantName: string | null;
    assigneeName: string | null;
    updatedAt: Date;
  }>;

export type TicketFilter = Readonly<{
  /** `active`: open, waiting on the customer or escalated. */
  status?: TicketStatus | "active";
  priority?: TicketPriority;
  category?: TicketCategory;
  tenantId?: string;
  tenantUserId?: string;
  assigneeId?: string;
  /** Only tickets past an SLA target. */
  breached?: boolean;
  /** Number, subject or requester. */
  q?: string;
  limit: number;
}>;

export type SupportSummary = Readonly<{
  active: number;
  unassigned: number;
  escalated: number;
  waitingOnCustomer: number;
  breached: number;
  byPriority: Readonly<Record<TicketPriority, number>>;
  /** Over the period: tickets raised and resolved, first-response time and satisfaction. */
  period: Readonly<{
    raised: number;
    resolved: number;
    firstResponseMetPercent: number | null;
    resolutionMetPercent: number | null;
    medianFirstResponseMinutes: number | null;
    satisfactionAverage: number | null;
    ratings: number;
  }>;
}>;

export type CannedResponse = Readonly<{
  id: string;
  title: string;
  body: string;
  category: TicketCategory | null;
  active: boolean;
  uses: number;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}>;

export type CannedResponseInput = Readonly<{
  title: string;
  body: string;
  category: TicketCategory | null;
  active: boolean;
}>;

/** The support desk in the platform database (docs/27 §3.13). */
export interface ISupportDesk {
  /** The next ticket number of the year, `AF-SUP-2026-000001`. */
  nextNumber(year: number): Promise<string>;
  insert(ticket: SupportTicket): Promise<void>;
  /** The ticket locked for a change (inside the platform unit of work). */
  lock(id: string): Promise<SupportTicket | null>;
  save(ticket: SupportTicket): Promise<void>;
  find(id: string): Promise<TicketView | null>;
  list(filter: TicketFilter): Promise<TicketView[]>;
  addMessage(message: NewTicketMessage): Promise<TicketMessage>;
  messages(ticketId: string, includeInternal: boolean): Promise<TicketMessage[]>;
  /** Tickets the sweep may have to act on: a target passed, or quiet for a week. */
  sweepCandidates(now: Date, limit: number): Promise<string[]>;
  summary(since: Date, now: Date): Promise<SupportSummary>;

  slaTargets(): Promise<SlaTargets>;
  setSlaTarget(target: SlaTarget, staffId: string): Promise<void>;

  cannedResponses(activeOnly: boolean): Promise<CannedResponse[]>;
  cannedResponse(id: string): Promise<CannedResponse | null>;
  createCanned(input: CannedResponseInput, staffId: string): Promise<CannedResponse>;
  updateCanned(
    id: string,
    input: CannedResponseInput,
    staffId: string,
  ): Promise<CannedResponse | null>;
  cannedUsed(id: string): Promise<void>;

  /** Who a staff member is, for messages and emails. */
  staffName(staffId: string): Promise<string | null>;
  /** The tenant's name, for canned responses and emails. */
  tenantName(tenantId: string): Promise<string | null>;
  /** Whether the data-protection request exists. */
  requestExists(requestId: string): Promise<boolean>;
}
