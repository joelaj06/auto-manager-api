const HOUR = 3_600;
const DAY = 86_400;

/** A share as a percent with one decimal (null when there is nothing to divide by). */
export function percent(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return Math.round((part / whole) * 1_000) / 10;
}

export type FleetTime = Readonly<{ rentedSeconds: number; unavailableSeconds: number }>;

export type Utilisation = Readonly<{
  vehicles: number;
  /** Hours on rent. */
  rentedHours: number;
  /** Hours the vehicles could be rented: the period less time blocked for other work. */
  availableHours: number;
  /** Rented over available hours. */
  percent: number | null;
}>;

/**
 * Utilisation (docs/07 §11): hours on rent over the hours the vehicles could have been rented —
 * the period for each vehicle, less maintenance and other blocks (decision 371).
 */
export function utilisation(fleet: readonly FleetTime[], periodSeconds: number): Utilisation {
  let rented = 0;
  let available = 0;
  for (const v of fleet) {
    const open = Math.max(0, periodSeconds - Math.min(periodSeconds, v.unavailableSeconds));
    rented += Math.min(v.rentedSeconds, periodSeconds);
    available += open;
  }
  return {
    vehicles: fleet.length,
    rentedHours: round1(rented / HOUR),
    availableHours: round1(available / HOUR),
    percent: percent(Math.min(rented, available), available),
  };
}

/**
 * Average daily rate: the time charges (before tax) over the days on rent; RevPAV: all revenue
 * over the vehicle-days available (decision 372). Minor units, rounded; null without days.
 */
export function averageDailyRate(timeRevenueMinor: number, rentedSeconds: number): number | null {
  if (rentedSeconds <= 0) return null;
  return Math.round(timeRevenueMinor / (rentedSeconds / DAY));
}

export function revenuePerAvailableVehicleDay(
  revenueMinor: number,
  availableSeconds: number,
): number | null {
  if (availableSeconds <= 0) return null;
  return Math.round(revenueMinor / (availableSeconds / DAY));
}

const round1 = (n: number) => Math.round(n * 10) / 10;
