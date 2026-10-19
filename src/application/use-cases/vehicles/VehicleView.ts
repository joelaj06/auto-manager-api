import { Money, type MoneyJson } from "../../../domain/money/Money.js";
import type { CustomFieldValue } from "../../../domain/vehicles/CustomFields.js";
import { Vehicle, type VehicleProps } from "../../../domain/vehicles/Vehicle.js";
import type { VehicleStatus } from "../../../domain/vehicles/VehicleStatus.js";

export type VehicleFinancialsView = Readonly<{
  acquisitionDate: string | null;
  acquisitionCost: MoneyJson | null;
  residualValue: MoneyJson | null;
  depreciationMethod: VehicleProps["depreciationMethod"];
  usefulLifeMonths: number | null;
  /** Today's book value (straight-line), or the cost when not depreciated. */
  bookValue: MoneyJson | null;
}>;

export type VehicleView = Readonly<{
  id: string;
  code: string;
  plateNumber: string | null;
  vin: string | null;
  engineNumber: string | null;
  chassisNumber: string | null;
  makeId: string | null;
  make: string;
  modelId: string | null;
  model: string;
  trim: string | null;
  year: number | null;
  colour: string | null;
  bodyType: VehicleProps["bodyType"];
  fuelType: VehicleProps["fuelType"];
  transmission: VehicleProps["transmission"];
  engineCc: number | null;
  seats: number | null;
  doors: number | null;
  drive: VehicleProps["drive"];
  usage: VehicleProps["usage"];
  ownershipType: VehicleProps["ownershipType"];
  ownershipNote: string | null;
  status: VehicleStatus;
  statusChangedAt: Date;
  branchId: string;
  odometer: Readonly<{ value: number; unit: VehicleProps["mileageUnit"]; readAt: Date }> | null;
  mileageUnit: VehicleProps["mileageUnit"];
  primaryPhotoFileId: string | null;
  groupIds: readonly string[];
  tags: readonly string[];
  specs: Readonly<Record<string, string | number>>;
  customFields: Readonly<Record<string, CustomFieldValue>>;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** Only with `vehicles.financials.view` for the vehicle's branch; otherwise absent. */
  financials?: VehicleFinancialsView;
}>;

export type ViewOptions = Readonly<{ financials: boolean; currency: string; today: string }>;

const money = (minor: number | null, currency: string) =>
  minor === null ? null : Money.ofMinor(minor, currency).toJSON();

export function vehicleView(p: VehicleProps, options: ViewOptions): VehicleView {
  const view: VehicleView = {
    id: p.id,
    code: p.code,
    plateNumber: p.plateNumber,
    vin: p.vin,
    engineNumber: p.engineNumber,
    chassisNumber: p.chassisNumber,
    makeId: p.makeId,
    make: p.make,
    modelId: p.modelId,
    model: p.model,
    trim: p.trim,
    year: p.year,
    colour: p.colour,
    bodyType: p.bodyType,
    fuelType: p.fuelType,
    transmission: p.transmission,
    engineCc: p.engineCc,
    seats: p.seats,
    doors: p.doors,
    drive: p.drive,
    usage: p.usage,
    ownershipType: p.ownershipType,
    ownershipNote: p.ownershipNote,
    status: p.status,
    statusChangedAt: p.statusChangedAt,
    branchId: p.branchId,
    odometer:
      p.currentOdometer === null || p.odometerReadAt === null
        ? null
        : { value: p.currentOdometer, unit: p.mileageUnit, readAt: p.odometerReadAt },
    mileageUnit: p.mileageUnit,
    primaryPhotoFileId: p.primaryPhotoFileId,
    groupIds: p.groupIds,
    tags: p.tags,
    specs: p.specs,
    customFields: p.customFields,
    notes: p.notes,
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  };
  if (!options.financials) return view;
  const bookValue = Vehicle.restore(p).bookValue(options.today, options.currency);
  return {
    ...view,
    financials: {
      acquisitionDate: p.acquisitionDate,
      acquisitionCost: money(p.acquisitionCostMinor, options.currency),
      residualValue: money(p.residualValueMinor, options.currency),
      depreciationMethod: p.depreciationMethod,
      usefulLifeMonths: p.usefulLifeMonths,
      bookValue: bookValue?.toJSON() ?? null,
    },
  };
}
