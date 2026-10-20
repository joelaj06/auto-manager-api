import { DomainError } from "../errors/DomainError.js";

export class VehicleIssueError extends DomainError {
  readonly code = "VEHICLE_ISSUE_RULE";
  constructor(message: string) {
    super(message);
  }
}

export const ISSUE_TYPES = [
  "breakdown",
  "accident",
  "damage",
  "tyre",
  "warning_light",
  "police",
  "theft",
  "other",
] as const;
export type IssueType = (typeof ISSUE_TYPES)[number];
export const ISSUE_SEVERITIES = ["low", "medium", "high"] as const;
export type IssueSeverity = (typeof ISSUE_SEVERITIES)[number];
export type IssueStatus = "open" | "acknowledged" | "resolved";

export type VehicleIssueProps = Readonly<{
  id: string;
  number: string;
  vehicleId: string;
  branchId: string;
  driverId: string | null;
  reportedBy: string | null;
  type: IssueType;
  severity: IssueSeverity;
  canDrive: boolean;
  description: string;
  odometer: number | null;
  location: string | null;
  occurredAt: Date;
  status: IssueStatus;
  acknowledgedBy: string | null;
  acknowledgedAt: Date | null;
  resolution: string | null;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}>;

export type IssueReport = Readonly<{
  type: IssueType;
  severity?: IssueSeverity;
  canDrive?: boolean;
  description: string;
  odometer?: number | null;
  location?: string | null;
  occurredAt?: Date;
}>;

const text = (value: string | null | undefined) => {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
};

/**
 * Something wrong with a vehicle, reported from the road (docs/09 §4): a breakdown, an accident,
 * damage, a warning light … Staff acknowledge it (they are on it) and resolve it with what was
 * done. Accidents, thefts and vehicles that cannot drive are always high severity.
 */
export class VehicleIssue {
  private constructor(private props: VehicleIssueProps) {}

  static report(
    params: Readonly<{
      id: string;
      number: string;
      vehicleId: string;
      branchId: string;
      driverId: string | null;
      reportedBy: string | null;
      now: Date;
    }> &
      IssueReport,
  ): VehicleIssue {
    const description = params.description.trim();
    if (description.length < 3) throw new VehicleIssueError("Describe what happened");
    if (params.occurredAt !== undefined && params.occurredAt > params.now)
      throw new VehicleIssueError("It cannot have happened in the future");
    const canDrive = params.canDrive ?? true;
    const serious = params.type === "accident" || params.type === "theft" || !canDrive;
    return new VehicleIssue({
      id: params.id,
      number: params.number,
      vehicleId: params.vehicleId,
      branchId: params.branchId,
      driverId: params.driverId,
      reportedBy: params.reportedBy,
      type: params.type,
      severity: serious ? "high" : (params.severity ?? "medium"),
      canDrive,
      description,
      odometer: params.odometer ?? null,
      location: text(params.location),
      occurredAt: params.occurredAt ?? params.now,
      status: "open",
      acknowledgedBy: null,
      acknowledgedAt: null,
      resolution: null,
      resolvedBy: null,
      resolvedAt: null,
      createdAt: params.now,
      updatedAt: params.now,
    });
  }

  static restore(props: VehicleIssueProps): VehicleIssue {
    return new VehicleIssue(props);
  }

  get id(): string {
    return this.props.id;
  }

  acknowledge(userId: string, now: Date): void {
    if (this.props.status !== "open")
      throw new VehicleIssueError("Only an open issue can be acknowledged");
    this.props = {
      ...this.props,
      status: "acknowledged",
      acknowledgedBy: userId,
      acknowledgedAt: now,
      updatedAt: now,
    };
  }

  resolve(userId: string, resolution: string, now: Date): void {
    if (this.props.status === "resolved")
      throw new VehicleIssueError("This issue is already resolved");
    const done = resolution.trim();
    if (done.length < 3) throw new VehicleIssueError("Say how it was resolved");
    this.props = {
      ...this.props,
      status: "resolved",
      acknowledgedBy: this.props.acknowledgedBy ?? userId,
      acknowledgedAt: this.props.acknowledgedAt ?? now,
      resolution: done,
      resolvedBy: userId,
      resolvedAt: now,
      updatedAt: now,
    };
  }

  /** Reopens a resolved issue that came back. */
  reopen(now: Date): void {
    if (this.props.status !== "resolved")
      throw new VehicleIssueError("Only a resolved issue can be reopened");
    this.props = {
      ...this.props,
      status: "acknowledged",
      resolution: null,
      resolvedBy: null,
      resolvedAt: null,
      updatedAt: now,
    };
  }

  snapshot(): VehicleIssueProps {
    return this.props;
  }
}
