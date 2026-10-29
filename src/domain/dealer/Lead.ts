import { DomainError } from "../errors/DomainError.js";

export class LeadRuleError extends DomainError {
  readonly code = "LEAD_RULE";
  constructor(message: string) {
    super(message);
  }
}

export const LEAD_SOURCES = [
  "walk_in",
  "phone",
  "whatsapp",
  "website",
  "social",
  "referral",
  "other",
] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

export const LEAD_STAGES = [
  "new",
  "contacted",
  "appointment",
  "test_drive",
  "negotiation",
  "won",
  "lost",
] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];
export const OPEN_STAGES: readonly LeadStage[] = [
  "new",
  "contacted",
  "appointment",
  "test_drive",
  "negotiation",
];

/** What the lead is after: a stock vehicle, or a saved search told when a match is listed. */
export type LeadInterest = Readonly<{
  vehicleId: string | null;
  make: string | null;
  model: string | null;
  yearFrom: number | null;
  yearTo: number | null;
  budgetMaxMinor: number | null;
  notifyMatches: boolean;
}>;

export type LeadContact = Readonly<{
  name: string;
  /** E.164, already parsed. */
  phone: string | null;
  email: string | null;
  customerId: string | null;
}>;

export type LeadDetails = LeadContact &
  LeadInterest &
  Readonly<{ source: LeadSource; notes: string | null }>;

export type LeadProps = LeadDetails &
  Readonly<{
    id: string;
    number: string;
    branchId: string;
    stage: LeadStage;
    lostReason: string | null;
    assignedTo: string | null;
    assignedAt: Date | null;
    stageChangedAt: Date;
    closedAt: Date | null;
    createdBy: string | null;
    createdAt: Date;
    updatedAt: Date;
  }>;

/** A listed vehicle as a saved search sees it. */
export type MatchCandidate = Readonly<{
  make: string;
  model: string;
  year: number | null;
  askingPriceMinor: number | null;
}>;

/**
 * A sales lead (docs/10 §4): a person interested in a vehicle, moved along the pipeline new →
 * contacted → appointment → test drive → negotiation → won or lost (with a reason), assigned to
 * a sales executive (decisions 437–444).
 */
export class Lead {
  private constructor(private props: LeadProps) {}

  static open(
    input: LeadDetails &
      Readonly<{
        id: string;
        number: string;
        branchId: string;
        createdBy: string | null;
        now: Date;
      }>,
  ): Lead {
    const { id, number, branchId, createdBy, now, ...details } = input;
    return new Lead({
      ...check(details),
      id,
      number,
      branchId,
      stage: "new",
      lostReason: null,
      assignedTo: null,
      assignedAt: null,
      stageChangedAt: now,
      closedAt: null,
      createdBy,
      createdAt: now,
      updatedAt: now,
    });
  }

  static restore(props: LeadProps): Lead {
    return new Lead(props);
  }

  get id(): string {
    return this.props.id;
  }

  get stage(): LeadStage {
    return this.props.stage;
  }

  get isOpen(): boolean {
    return OPEN_STAGES.includes(this.props.stage);
  }

  snapshot(): LeadProps {
    return this.props;
  }

  revise(details: LeadDetails, now: Date): void {
    this.props = { ...this.props, ...check(details), updatedAt: now };
  }

  /** Assigns (or unassigns with null) the lead; returns the previous assignee. */
  assign(userId: string | null, now: Date): string | null {
    const before = this.props.assignedTo;
    if (before === userId) throw new LeadRuleError("The lead is already with them");
    this.props = {
      ...this.props,
      assignedTo: userId,
      assignedAt: userId === null ? null : now,
      updatedAt: now,
    };
    return before;
  }

  /**
   * Moves the lead to another stage (forward or back while open). Lost needs a reason; a closed
   * lead is reopened by moving it to an open stage.
   */
  moveTo(stage: LeadStage, reason: string | null, now: Date): LeadStage {
    const from = this.props.stage;
    if (stage === from) throw new LeadRuleError(`The lead is already ${words(stage)}`);
    const lostReason = stage === "lost" ? (reason?.trim() ?? "") : null;
    if (lostReason !== null && lostReason.length < 3)
      throw new LeadRuleError("Say why the lead was lost");
    const closing = stage === "won" || stage === "lost";
    this.props = {
      ...this.props,
      stage,
      lostReason,
      stageChangedAt: now,
      closedAt: closing ? now : null,
      updatedAt: now,
    };
    return from;
  }

  /** Moves an open lead forward to `stage` when it is behind it (a test drive, a quote …). */
  advanceTo(stage: LeadStage, now: Date): boolean {
    if (!this.isOpen) return false;
    if (OPEN_STAGES.indexOf(this.props.stage) >= OPEN_STAGES.indexOf(stage)) return false;
    this.moveTo(stage, null, now);
    return true;
  }

  /** Whether a listed vehicle fits the lead's saved search. */
  matches(candidate: MatchCandidate): boolean {
    const p = this.props;
    if (!p.notifyMatches || p.make === null || !this.isOpen) return false;
    if (candidate.make.toLowerCase() !== p.make.toLowerCase()) return false;
    if (p.model !== null && candidate.model.toLowerCase() !== p.model.toLowerCase()) return false;
    if (p.yearFrom !== null && (candidate.year === null || candidate.year < p.yearFrom))
      return false;
    if (p.yearTo !== null && (candidate.year === null || candidate.year > p.yearTo)) return false;
    if (
      p.budgetMaxMinor !== null &&
      (candidate.askingPriceMinor === null || candidate.askingPriceMinor > p.budgetMaxMinor)
    )
      return false;
    return true;
  }
}

function check(d: LeadDetails): LeadDetails {
  const name = d.name.trim();
  if (name === "") throw new LeadRuleError("Give the person's name");
  if (d.phone === null && (d.email ?? "").trim() === "" && d.customerId === null)
    throw new LeadRuleError("Give a phone number or email to reach them");
  if (d.yearFrom !== null && d.yearTo !== null && d.yearFrom > d.yearTo)
    throw new LeadRuleError("The years run from the earlier to the later");
  if (
    d.budgetMaxMinor !== null &&
    !(Number.isSafeInteger(d.budgetMaxMinor) && d.budgetMaxMinor >= 0)
  )
    throw new LeadRuleError("The budget is zero or more");
  const make = clean(d.make);
  if (d.notifyMatches && make === null)
    throw new LeadRuleError("A saved search needs at least the make");
  return {
    ...d,
    name,
    email: clean(d.email)?.toLowerCase() ?? null,
    make,
    model: clean(d.model),
    notes: clean(d.notes),
  };
}

function clean(value: string | null): string | null {
  const text = value?.trim() ?? "";
  return text === "" ? null : text;
}

function words(stage: LeadStage): string {
  return stage.replaceAll("_", " ");
}

/** Conversion: won out of the leads closed or not, as a percentage to one decimal. */
export function conversionRate(won: number, total: number): string | null {
  if (total === 0) return null;
  const tenths = Math.round((won * 1000) / total);
  return `${Math.floor(tenths / 10)}.${tenths % 10}`;
}
