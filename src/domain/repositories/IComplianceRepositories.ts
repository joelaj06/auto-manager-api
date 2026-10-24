// --- data-protection requests (docs/27 §3.15) ---

export type DprKind = "access" | "correction" | "erasure" | "objection";
export type DprStatus = "open" | "in_progress" | "completed" | "rejected";

export type DprStep = Readonly<{ at: Date; by: string; note: string }>;

export type DataProtectionRequest = Readonly<{
  id: string;
  code: string;
  kind: DprKind;
  tenantId: string | null;
  requesterName: string;
  requesterContact: string;
  subject: string;
  receivedAt: Date;
  dueAt: Date;
  status: DprStatus;
  assignedTo: string | null;
  steps: readonly DprStep[];
  outcome: string | null;
  closedAt: Date | null;
  createdBy: string;
  createdAt: Date;
}>;

export interface IDataProtectionRequestRepository {
  nextCode(year: number): Promise<string>;
  save(request: DataProtectionRequest): Promise<void>;
  find(id: string, lock?: boolean): Promise<DataProtectionRequest | null>;
  list(
    filter: Readonly<{ status?: DprStatus; openOnly?: boolean; limit: number }>,
  ): Promise<DataProtectionRequest[]>;
  /** Open requests due before `before`. */
  dueBefore(before: Date): Promise<DataProtectionRequest[]>;
}

// --- incidents (the status page) ---

export type IncidentImpact = "minor" | "major" | "critical";
export type IncidentStatus = "investigating" | "identified" | "monitoring" | "resolved";

export type IncidentUpdate = Readonly<{ status: IncidentStatus; message: string; postedAt: Date }>;

export type Incident = Readonly<{
  id: string;
  title: string;
  impact: IncidentImpact;
  status: IncidentStatus;
  components: readonly string[];
  startedAt: Date;
  resolvedAt: Date | null;
  createdBy: string;
  updates: readonly IncidentUpdate[];
}>;

export interface IIncidentRepository {
  save(incident: Omit<Incident, "updates">): Promise<void>;
  addUpdate(incidentId: string, update: IncidentUpdate, postedBy: string): Promise<void>;
  find(id: string, lock?: boolean): Promise<Incident | null>;
  /** Unresolved, and those resolved since `since`, newest first. */
  recent(since: Date, limit: number): Promise<Incident[]>;
}

// --- restore drills (docs/26 §7) ---

export type DrillKind = "quarterly_game_day" | "restore_test";
export type DrillOutcome = "passed" | "partial" | "failed";

export type RestoreDrill = Readonly<{
  id: string;
  kind: DrillKind;
  dueOn: string;
  status: "scheduled" | "done" | "missed";
  performedAt: Date | null;
  performedBy: string | null;
  outcome: DrillOutcome | null;
  rtoMinutes: number | null;
  rpoMinutes: number | null;
  notes: string | null;
  createdAt: Date;
}>;

export interface IRestoreDrillRepository {
  save(drill: RestoreDrill): Promise<void>;
  find(id: string, lock?: boolean): Promise<RestoreDrill | null>;
  scheduled(kind: DrillKind): Promise<RestoreDrill | null>;
  list(limit: number): Promise<RestoreDrill[]>;
}
