import { DomainError } from "../errors/DomainError.js";

export const ASSIGNMENT_TYPES = ["remittance", "salary", "chauffeur", "workpay"] as const;
export type AssignmentType = (typeof ASSIGNMENT_TYPES)[number];
export const REMITTANCE_MODES = ["fixed_target", "variable", "none"] as const;
export type RemittanceMode = (typeof REMITTANCE_MODES)[number];
export const TARGET_FREQUENCIES = ["daily", "weekly", "monthly"] as const;
export type TargetFrequency = (typeof TARGET_FREQUENCIES)[number];
export const FUEL_LEVELS = ["empty", "quarter", "half", "three_quarters", "full"] as const;
export type FuelLevel = (typeof FUEL_LEVELS)[number];

/** What the driver owes per period (docs/09 §2.1, decision 8). */
export type RemittanceTerms = Readonly<{
  mode: RemittanceMode;
  /** Minor units of the base currency per period (fixed target only). */
  targetMinor: number | null;
  frequency: TargetFrequency | null;
  /** Days without a target for daily targets (0 = Sunday … 6 = Saturday). */
  daysOff: readonly number[];
}>;

export type ChecklistItemDefinition = Readonly<{ key: string; label: string }>;

/** The handover inspection (docs/06 §6): what was checked when the keys changed hands. */
export type HandoverChecklist = Readonly<{
  items: readonly Readonly<{ key: string; label: string; ok: boolean; note: string | null }>[];
  fuelLevel: FuelLevel | null;
  notes: string | null;
  /** The driver confirmed the checklist (signed the paper form or tapped "agree"). */
  driverAcknowledged: boolean;
}>;

export type ChecklistAnswers = Readonly<{
  items: readonly Readonly<{ key: string; ok: boolean; note?: string | null }>[];
  fuelLevel?: FuelLevel | null;
  notes?: string | null;
  driverAcknowledged?: boolean;
}>;

export type VehicleAssignmentProps = Readonly<{
  id: string;
  vehicleId: string;
  driverId: string;
  branchId: string;
  type: AssignmentType;
  terms: RemittanceTerms;
  startedAt: Date;
  startOdometer: number;
  startChecklist: HandoverChecklist;
  startedBy: string | null;
  endedAt: Date | null;
  endOdometer: number | null;
  endChecklist: HandoverChecklist | null;
  endReason: string | null;
  endedBy: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}>;

export class AssignmentRuleError extends DomainError {
  readonly code = "ASSIGNMENT_RULE";
  constructor(message: string) {
    super(message);
  }
}

/** Default handover checklist (vehicle settings may replace it). */
export const DEFAULT_HANDOVER_ITEMS: readonly ChecklistItemDefinition[] = Object.freeze([
  { key: "spare_tyre", label: "Spare tyre" },
  { key: "jack_and_spanner", label: "Jack and wheel spanner" },
  { key: "fire_extinguisher", label: "Fire extinguisher" },
  { key: "warning_triangle", label: "Warning triangle" },
  { key: "first_aid_kit", label: "First aid kit" },
  { key: "vehicle_documents", label: "Insurance and roadworthy stickers in the vehicle" },
  { key: "body_condition", label: "Body without new damage" },
  { key: "lights_and_tyres", label: "Lights and tyres in good order" },
  { key: "clean", label: "Clean inside and out" },
]);

/** The terms, checked: a fixed target needs its amount and period; other modes carry none. */
export function checkTerms(terms: RemittanceTerms): RemittanceTerms {
  const daysOff = [...new Set(terms.daysOff)].sort();
  if (daysOff.some((d) => !Number.isInteger(d) || d < 0 || d > 6))
    throw new AssignmentRuleError("Days off are 0 (Sunday) to 6 (Saturday)");
  if (terms.mode !== "fixed_target")
    return { mode: terms.mode, targetMinor: null, frequency: null, daysOff: [] };
  if (terms.targetMinor === null || terms.targetMinor <= 0 || terms.frequency === null)
    throw new AssignmentRuleError("A fixed target needs an amount and a period (daily, weekly …)");
  if (terms.frequency !== "daily" && daysOff.length > 0)
    throw new AssignmentRuleError("Days off apply to daily targets only");
  if (daysOff.length === 7) throw new AssignmentRuleError("A daily target needs a working day");
  return { ...terms, daysOff };
}

/**
 * The handover checklist: every configured item answered (ok or not, with an optional note);
 * unknown items refused. Labels come from the definitions, so later renames do not rewrite
 * history.
 */
export function buildChecklist(
  definitions: readonly ChecklistItemDefinition[],
  answers: ChecklistAnswers,
): HandoverChecklist {
  const byKey = new Map(answers.items.map((a) => [a.key, a]));
  for (const key of byKey.keys())
    if (!definitions.some((d) => d.key === key))
      throw new AssignmentRuleError(`Unknown checklist item "${key}"`);
  const missing = definitions.filter((d) => !byKey.has(d.key));
  if (missing.length > 0)
    throw new AssignmentRuleError(
      `Answer every checklist item (missing: ${missing.map((d) => d.label).join(", ")})`,
    );
  const text = (value: string | null | undefined, max: number) => {
    const trimmed = value?.trim() ?? "";
    if (trimmed.length > max) throw new AssignmentRuleError(`Keep notes under ${max} characters`);
    return trimmed === "" ? null : trimmed;
  };
  return {
    items: definitions.map((d) => {
      const answer = byKey.get(d.key)!;
      return { key: d.key, label: d.label, ok: answer.ok, note: text(answer.note, 300) };
    }),
    fuelLevel: answers.fuelLevel ?? null,
    notes: text(answers.notes, 2_000),
    driverAcknowledged: answers.driverAcknowledged ?? false,
  };
}

/**
 * A vehicle in a driver's hands for a period (docs/06 §6). Starts with the handover checklist
 * and the odometer; ends with the same, never before it started, never with a lower odometer.
 * One open assignment per vehicle and per driver (decision 9) is guaranteed by the database.
 */
export class VehicleAssignment {
  private constructor(private props: VehicleAssignmentProps) {}

  static start(
    params: Readonly<{
      id: string;
      vehicleId: string;
      driverId: string;
      branchId: string;
      type: AssignmentType;
      terms: RemittanceTerms;
      startedAt: Date;
      startOdometer: number;
      checklist: HandoverChecklist;
      startedBy: string | null;
      notes: string | null;
      now: Date;
    }>,
  ): VehicleAssignment {
    if (params.startedAt.getTime() > params.now.getTime() + 5 * 60_000)
      throw new AssignmentRuleError("An assignment cannot start in the future");
    if (params.type === "salary" && params.terms.mode === "fixed_target")
      throw new AssignmentRuleError("A salaried driver has no remittance target");
    const notes = params.notes?.trim() ?? "";
    return new VehicleAssignment({
      id: params.id,
      vehicleId: params.vehicleId,
      driverId: params.driverId,
      branchId: params.branchId,
      type: params.type,
      terms: checkTerms(params.terms),
      startedAt: params.startedAt,
      startOdometer: params.startOdometer,
      startChecklist: params.checklist,
      startedBy: params.startedBy,
      endedAt: null,
      endOdometer: null,
      endChecklist: null,
      endReason: null,
      endedBy: null,
      notes: notes === "" ? null : notes.slice(0, 2_000),
      createdAt: params.now,
      updatedAt: params.now,
    });
  }

  static restore(props: VehicleAssignmentProps): VehicleAssignment {
    return new VehicleAssignment(props);
  }

  get id(): string {
    return this.props.id;
  }

  get open(): boolean {
    return this.props.endedAt === null;
  }

  snapshot(): VehicleAssignmentProps {
    return this.props;
  }

  end(
    params: Readonly<{
      endedAt: Date;
      endOdometer: number;
      checklist: HandoverChecklist;
      reason: string;
      endedBy: string | null;
      now: Date;
    }>,
  ): void {
    if (!this.open) throw new AssignmentRuleError("This assignment has already ended");
    if (params.endedAt.getTime() > params.now.getTime() + 5 * 60_000)
      throw new AssignmentRuleError("An assignment cannot end in the future");
    if (params.endedAt <= this.props.startedAt)
      throw new AssignmentRuleError("An assignment ends after it started");
    if (params.endOdometer < this.props.startOdometer)
      throw new AssignmentRuleError(
        `The odometer cannot be lower than at the start (${this.props.startOdometer})`,
      );
    const reason = params.reason.trim();
    if (reason.length < 3) throw new AssignmentRuleError("Give a reason for ending it");
    this.props = {
      ...this.props,
      endedAt: params.endedAt,
      endOdometer: params.endOdometer,
      endChecklist: params.checklist,
      endReason: reason.slice(0, 500),
      endedBy: params.endedBy,
      updatedAt: params.now,
    };
  }

  /** New terms from now on (the remittance rows already generated keep theirs). */
  changeTerms(terms: RemittanceTerms, now: Date): void {
    if (!this.open) throw new AssignmentRuleError("This assignment has already ended");
    if (this.props.type === "salary" && terms.mode === "fixed_target")
      throw new AssignmentRuleError("A salaried driver has no remittance target");
    this.props = { ...this.props, terms: checkTerms(terms), updatedAt: now };
  }

  /** Kilometres driven during the assignment (null while open). */
  get distance(): number | null {
    return this.props.endOdometer === null
      ? null
      : this.props.endOdometer - this.props.startOdometer;
  }
}
