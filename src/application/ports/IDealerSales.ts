import type { Lead, LeadSource, LeadStage } from "../../domain/dealer/Lead.js";
import type { Quote, QuoteStatus } from "../../domain/dealer/Quote.js";
import type { TestDrive, TestDriveStatus } from "../../domain/dealer/TestDrive.js";

export type LeadFilter = Readonly<{
  branchIds: "all" | readonly string[];
  branchId?: string;
  /** Own scope: only leads assigned to this user. */
  assignedTo?: string;
  unassigned?: boolean;
  stages?: readonly LeadStage[];
  sources?: readonly LeadSource[];
  /** Name, phone, email or number. */
  search?: string;
  limit: number;
  /** Newest first: rows created before this one. */
  beforeId?: string;
}>;

export const ACTIVITY_KINDS = [
  "call",
  "message",
  "whatsapp",
  "email",
  "visit",
  "note",
  "stage",
  "assignment",
  "test_drive",
  "quote",
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export type LeadActivity = Readonly<{
  id: string;
  leadId: string;
  kind: ActivityKind;
  note: string | null;
  details: Readonly<Record<string, string | number | boolean | null>>;
  occurredAt: Date;
  recordedBy: string | null;
  recordedAt: Date;
}>;

export type LeadTask = Readonly<{
  id: string;
  leadId: string;
  title: string;
  dueOn: string;
  assignedTo: string | null;
  doneAt: Date | null;
  doneBy: string | null;
  createdBy: string | null;
  createdAt: Date;
}>;

/** An open follow-up due by a day, with what the reminder says. */
export type DueTask = LeadTask &
  Readonly<{ leadNumber: string; leadName: string; branchId: string }>;

/** A listed stock vehicle a saved search may match. */
export type ListedVehicle = Readonly<{
  vehicleId: string;
  branchId: string;
  code: string;
  plateNumber: string | null;
  make: string;
  model: string;
  year: number | null;
  askingPriceMinor: number | null;
}>;

/** Leads created in a period, grouped by source and assignee, counted by where they are now. */
export type FunnelRow = Readonly<{
  source: LeadSource;
  assignedTo: string | null;
  stage: LeadStage;
  leads: number;
}>;

/** Leads, their activity, follow-ups, saved-search matches and assignment pool, docs/10 §4. */
export interface ILeads {
  insert(lead: Lead): Promise<void>;
  update(lead: Lead): Promise<void>;
  get(id: string): Promise<Lead | null>;
  lock(id: string): Promise<Lead | null>;
  list(filter: LeadFilter): Promise<Lead[]>;
  addActivity(activity: LeadActivity): Promise<void>;
  activities(leadId: string): Promise<LeadActivity[]>;
  saveTask(task: LeadTask): Promise<void>;
  task(id: string): Promise<LeadTask | null>;
  tasks(leadId: string): Promise<LeadTask[]>;
  /** Open follow-ups due on or before the day. */
  dueTasks(onOrBefore: string): Promise<DueTask[]>;
  /** The branch's round-robin pool in turn order. */
  pool(branchId: string): Promise<string[]>;
  setPool(branchId: string, userIds: readonly string[]): Promise<void>;
  /** When each of these users was last given a lead (null: never). */
  lastAssigned(userIds: readonly string[]): Promise<Map<string, Date | null>>;
  /** Open leads with a saved search told of matches. */
  savedSearches(): Promise<Lead[]>;
  /** Stock vehicles listed for sale. */
  listedVehicles(): Promise<ListedVehicle[]>;
  /** Records a match; false when it was already told. */
  recordMatch(leadId: string, vehicleId: string): Promise<boolean>;
  funnel(
    filter: Readonly<{
      branchIds: "all" | readonly string[];
      assignedTo?: string;
      from: Date;
      until: Date;
    }>,
  ): Promise<FunnelRow[]>;
  customer(id: string): Promise<Readonly<{ name: string; phone: string | null }> | null>;
}

export type TestDriveFilter = Readonly<{
  branchIds: "all" | readonly string[];
  vehicleId?: string;
  leadId?: string;
  statuses?: readonly TestDriveStatus[];
  from?: Date;
  until?: Date;
  limit: number;
  beforeId?: string;
}>;

export interface ITestDrives {
  insert(drive: TestDrive): Promise<void>;
  update(drive: TestDrive): Promise<void>;
  get(id: string): Promise<TestDrive | null>;
  lock(id: string): Promise<TestDrive | null>;
  list(filter: TestDriveFilter): Promise<TestDrive[]>;
}

export type QuoteFilter = Readonly<{
  branchIds: "all" | readonly string[];
  leadId?: string;
  vehicleId?: string;
  customerId?: string;
  statuses?: readonly QuoteStatus[];
  limit: number;
  beforeId?: string;
}>;

export interface IQuotes {
  insert(quote: Quote): Promise<void>;
  /** Saves the quote with its add-ons replaced. */
  update(quote: Quote): Promise<void>;
  get(id: string): Promise<Quote | null>;
  lock(id: string): Promise<Quote | null>;
  list(filter: QuoteFilter): Promise<Quote[]>;
  /** Sent quotes valid until before the day. */
  lapsed(today: string): Promise<string[]>;
}
