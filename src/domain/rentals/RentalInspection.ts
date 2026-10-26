import {
  FUEL_LEVELS,
  type ChecklistItemDefinition,
  type FuelLevel,
} from "../assignments/VehicleAssignment.js";
import { DomainError } from "../errors/DomainError.js";

export class RentalInspectionError extends DomainError {
  readonly code = "RENTAL_INSPECTION_RULE";
  constructor(message: string) {
    super(message);
  }
}

export const INSPECTION_STAGES = ["check_out", "check_in"] as const;
export type InspectionStage = (typeof INSPECTION_STAGES)[number];

/** The sides of the damage map (docs/07 §6); `other` for anything else worth a photo. */
export const PHOTO_VIEWS = ["front", "back", "left", "right", "interior", "other"] as const;
export type PhotoView = (typeof PHOTO_VIEWS)[number];

export const DEFAULT_INSPECTION_ITEMS: readonly ChecklistItemDefinition[] = Object.freeze([
  { key: "spare_tyre", label: "Spare tyre" },
  { key: "jack_and_spanner", label: "Jack and wheel spanner" },
  { key: "warning_triangle", label: "Warning triangle" },
  { key: "fire_extinguisher", label: "Fire extinguisher" },
  { key: "vehicle_documents", label: "Insurance and roadworthy stickers in the vehicle" },
  { key: "lights_and_tyres", label: "Lights and tyres in good order" },
  { key: "air_conditioning", label: "Air conditioning works" },
  { key: "clean", label: "Clean inside and out" },
]);

export type InspectionItem = Readonly<{
  key: string;
  label: string;
  ok: boolean;
  note: string | null;
}>;

export type InspectionPhoto = Readonly<{ fileId: string; view: PhotoView }>;

export type RentalInspection = Readonly<{
  id: string;
  bookingId: string;
  stage: InspectionStage;
  vehicleId: string;
  odometer: number;
  fuel: FuelLevel;
  checklist: readonly InspectionItem[];
  idChecked: boolean;
  photos: readonly InspectionPhoto[];
  notes: string | null;
  inspectedBy: string | null;
  inspectedAt: Date;
}>;

export type ChecklistAnswer = Readonly<{ key: string; ok: boolean; note?: string | null }>;

const text = (value: string | null | undefined, max: number, what: string) => {
  const trimmed = value?.trim() ?? "";
  if (trimmed.length > max) throw new RentalInspectionError(`Keep ${what} under ${max} characters`);
  return trimmed === "" ? null : trimmed;
};

/**
 * An inspection as recorded: every item of the business's list answered (labels kept as they were
 * then), the required sides photographed, each photo used once.
 */
export function inspect(params: {
  id: string;
  bookingId: string;
  stage: InspectionStage;
  vehicleId: string;
  odometer: number;
  fuel: FuelLevel;
  items: readonly ChecklistItemDefinition[];
  answers: readonly ChecklistAnswer[];
  requiredViews: readonly PhotoView[];
  photos: readonly InspectionPhoto[];
  idChecked: boolean;
  notes?: string | null;
  inspectedBy: string | null;
  inspectedAt: Date;
}): RentalInspection {
  if (params.stage === "check_out" && !params.idChecked)
    throw new RentalInspectionError(
      "Check the renter's ID and driving licence before the keys are handed over",
    );
  const byKey = new Map(params.answers.map((a) => [a.key, a]));
  if (byKey.size !== params.answers.length)
    throw new RentalInspectionError("Answer each inspection item once");
  for (const key of byKey.keys())
    if (!params.items.some((d) => d.key === key))
      throw new RentalInspectionError(`Unknown inspection item "${key}"`);
  const missing = params.items.filter((d) => !byKey.has(d.key));
  if (missing.length > 0)
    throw new RentalInspectionError(
      `Answer every inspection item (missing: ${missing.map((d) => d.label).join(", ")})`,
    );
  const fileIds = params.photos.map((p) => p.fileId);
  if (new Set(fileIds).size !== fileIds.length)
    throw new RentalInspectionError("Each photo is used once");
  if (params.photos.length > 30) throw new RentalInspectionError("At most 30 photos");
  const shot = new Set(params.photos.map((p) => p.view));
  const unshot = params.requiredViews.filter((v) => !shot.has(v));
  if (unshot.length > 0)
    throw new RentalInspectionError(`Photograph the ${unshot.join(", ")} of the vehicle`);
  return {
    id: params.id,
    bookingId: params.bookingId,
    stage: params.stage,
    vehicleId: params.vehicleId,
    odometer: params.odometer,
    fuel: params.fuel,
    checklist: params.items.map((d) => {
      const answer = byKey.get(d.key)!;
      return { key: d.key, label: d.label, ok: answer.ok, note: text(answer.note, 300, "notes") };
    }),
    idChecked: params.idChecked,
    photos: params.photos,
    notes: text(params.notes, 2_000, "notes"),
    inspectedBy: params.inspectedBy,
    inspectedAt: params.inspectedAt,
  };
}

/** Quarter tanks the vehicle came back short (none when it came back fuller). */
export function quartersMissing(out: FuelLevel, back: FuelLevel): number {
  return Math.max(0, FUEL_LEVELS.indexOf(out) - FUEL_LEVELS.indexOf(back));
}

export type InspectionDifferences = Readonly<{
  km: number;
  fuel: Readonly<{ out: FuelLevel; in: FuelLevel; quartersMissing: number }>;
  /** Items fine at check-out and not at check-in. */
  checklist: readonly Readonly<{ key: string; label: string; note: string | null }>[];
  /** The photos of each side, out and in, to compare. */
  photos: readonly Readonly<{ view: PhotoView; out: readonly string[]; in: readonly string[] }>[];
}>;

/** What changed between check-out and check-in (docs/07 §6); new damages are listed apart. */
export function differences(out: RentalInspection, back: RentalInspection): InspectionDifferences {
  const before = new Map(out.checklist.map((i) => [i.key, i]));
  const ofView = (i: RentalInspection, view: PhotoView) =>
    i.photos.filter((p) => p.view === view).map((p) => p.fileId);
  return {
    km: back.odometer - out.odometer,
    fuel: { out: out.fuel, in: back.fuel, quartersMissing: quartersMissing(out.fuel, back.fuel) },
    checklist: back.checklist
      .filter((i) => !i.ok && before.get(i.key)?.ok !== false)
      .map((i) => ({ key: i.key, label: i.label, note: i.note })),
    photos: PHOTO_VIEWS.map((view) => ({
      view,
      out: ofView(out, view),
      in: ofView(back, view),
    })).filter((p) => p.out.length > 0 || p.in.length > 0),
  };
}
