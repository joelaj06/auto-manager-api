import { Money } from "../money/Money.js";

export const COST_KINDS = [
  "vehicle_price",
  "auction_fee",
  "origin_transport",
  "shipping",
  "marine_insurance",
  "port_charges",
  "import_duty",
  "vat_levies",
  "clearing",
  "registration",
  "number_plates",
  "local_transport",
  "repairs",
  "other",
] as const;
export type CostKind = (typeof COST_KINDS)[number];

/** How a cost shared by the purchase's vehicles is split (decision 424). */
export const ALLOCATIONS = ["value", "equal"] as const;
export type Allocation = (typeof ALLOCATIONS)[number];

/** A cost as it counts in the landed cost: what was capitalised, in base minor units. */
export type CountedCost = Readonly<{
  /** The vehicle it belongs to; null: shared by all. */
  lineId: string | null;
  kind: CostKind;
  allocation: Allocation;
  baseMinor: number;
}>;

export type LineLandedCost = Readonly<{
  lineId: string;
  /** The vehicle's price as capitalised. */
  priceMinor: number;
  directMinor: number;
  sharedMinor: number;
  totalMinor: number;
}>;

/**
 * Landed cost per vehicle (docs/11 §3, decision 424): its own costs plus its share of the shared
 * ones, split by value (the vehicles' capitalised prices; equally while none has one) or equally,
 * the shares always adding up to the cost.
 */
export function landedCost(
  lineIds: readonly string[],
  costs: readonly CountedCost[],
  base: string,
): LineLandedCost[] {
  const price = new Map(lineIds.map((id) => [id, 0]));
  const direct = new Map(lineIds.map((id) => [id, 0]));
  const shared = new Map(lineIds.map((id) => [id, 0]));
  for (const c of costs) {
    if (c.lineId === null || !direct.has(c.lineId)) continue;
    direct.set(c.lineId, direct.get(c.lineId)! + c.baseMinor);
    if (c.kind === "vehicle_price") price.set(c.lineId, price.get(c.lineId)! + c.baseMinor);
  }
  const values = lineIds.map((id) => Math.max(0, price.get(id)!));
  const byValue = values.some((v) => v > 0) ? values : lineIds.map(() => 1);
  for (const c of costs) {
    if (c.lineId !== null || lineIds.length === 0) continue;
    const weights = c.allocation === "value" ? byValue : lineIds.map(() => 1);
    const parts = Money.ofMinor(c.baseMinor, base).allocate(weights);
    lineIds.forEach((id, i) => shared.set(id, shared.get(id)! + parts[i]!.amountMinor));
  }
  return lineIds.map((lineId) => {
    const d = direct.get(lineId)!;
    const s = shared.get(lineId)!;
    return {
      lineId,
      priceMinor: price.get(lineId)!,
      directMinor: d - price.get(lineId)!,
      sharedMinor: s,
      totalMinor: d + s,
    };
  });
}
