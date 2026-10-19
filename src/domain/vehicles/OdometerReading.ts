import { DomainError } from "../errors/DomainError.js";

export const ODOMETER_SOURCES = [
  "manual",
  "import",
  "rental",
  "fuel",
  "service",
  "inspection",
  "assignment",
  "telematics",
] as const;

export type OdometerSource = (typeof ODOMETER_SOURCES)[number];

export type OdometerReadingProps = Readonly<{
  id: string;
  vehicleId: string;
  value: number;
  readAt: Date;
  source: OdometerSource;
  refId: string | null;
  replacement: boolean;
  note: string | null;
  recordedBy: string | null;
  createdAt: Date;
}>;

export class OdometerError extends DomainError {
  readonly code = "ODOMETER_INVALID";
  constructor(message: string) {
    super(message);
  }
}

/** Above this the reading is almost certainly a typo (an extra digit). */
export const MAX_ODOMETER = 5_000_000;

/**
 * Odometer readings only go up over time (docs/06 §5). A reading is checked against its
 * neighbours in time, so a late entry for last week must fit between the readings around it.
 * When the odometer itself was replaced, the reading says so (with a reason) and a new series
 * starts from its value.
 */
export function checkOdometerReading(
  reading: Readonly<{ value: number; readAt: Date; replacement: boolean; note: string | null }>,
  neighbours: Readonly<{
    before: Readonly<{ value: number; readAt: Date }> | null;
    after: Readonly<{ value: number; readAt: Date; replacement: boolean }> | null;
  }>,
  now: Date,
): void {
  if (!Number.isInteger(reading.value) || reading.value < 0 || reading.value > MAX_ODOMETER)
    throw new OdometerError(`An odometer reading is a whole number from 0 to ${MAX_ODOMETER}`);
  if (reading.readAt.getTime() > now.getTime() + 5 * 60_000)
    throw new OdometerError("An odometer reading cannot be in the future");
  if (reading.replacement) {
    if (reading.note === null || reading.note.trim().length < 3)
      throw new OdometerError("Say why the odometer was replaced");
    if (neighbours.after !== null && !neighbours.after.replacement)
      throw new OdometerError("A replacement must be the latest reading");
    return;
  }
  const { before, after } = neighbours;
  if (before !== null && reading.value < before.value)
    throw new OdometerError(
      `The reading is lower than ${before.value} on ${before.readAt.toISOString().slice(0, 10)}; ` +
        "if the odometer was replaced, record it as a replacement",
    );
  if (after !== null && !after.replacement && reading.value > after.value)
    throw new OdometerError(
      `The reading is higher than ${after.value} recorded later on ${after.readAt.toISOString().slice(0, 10)}`,
    );
}
