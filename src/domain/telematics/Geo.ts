import { DomainError } from "../errors/DomainError.js";

export class TelematicsRuleError extends DomainError {
  readonly code = "TELEMATICS_RULE";
  constructor(message: string) {
    super(message);
  }
}

export type Point = Readonly<{ latitude: number; longitude: number }>;

const EARTH_RADIUS_M = 6_371_008.8;
const rad = (degrees: number) => (degrees * Math.PI) / 180;

/** The great-circle distance between two points, in metres. */
export function distanceMeters(a: Point, b: Point): number {
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Ray casting on longitude/latitude, fine for the areas a fleet watches (not the poles). */
export function insidePolygon(point: Point, polygon: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    const crosses =
      a.latitude > point.latitude !== b.latitude > point.latitude &&
      point.longitude <
        ((b.longitude - a.longitude) * (point.latitude - a.latitude)) / (b.latitude - a.latitude) +
          a.longitude;
    if (crosses) inside = !inside;
  }
  return inside;
}

export const GEOFENCE_KINDS = ["circle", "polygon"] as const;
export type GeofenceKind = (typeof GEOFENCE_KINDS)[number];
export const GEOFENCE_ALERTS = ["enter", "exit", "both"] as const;
export type GeofenceAlert = (typeof GEOFENCE_ALERTS)[number];
export const MAX_POLYGON_POINTS = 200;

export type GeofenceShape =
  | Readonly<{ kind: "circle"; center: Point; radiusM: number }>
  | Readonly<{ kind: "polygon"; points: readonly Point[] }>;

export type GeofenceArea = Readonly<{
  id: string;
  name: string;
  shape: GeofenceShape;
  /** Watches only this branch's vehicles; null: every vehicle. */
  branchId: string | null;
  alertOn: GeofenceAlert;
}>;

export function contains(shape: GeofenceShape, point: Point): boolean {
  return shape.kind === "circle"
    ? distanceMeters(shape.center, point) <= shape.radiusM
    : insidePolygon(point, shape.points);
}

const validPoint = (p: Point) =>
  Number.isFinite(p.latitude) &&
  Number.isFinite(p.longitude) &&
  Math.abs(p.latitude) <= 90 &&
  Math.abs(p.longitude) <= 180;

/** A circle of 50 m to 500 km, or a polygon of 3 to 200 points that is not a line. */
export function checkGeofenceShape(shape: GeofenceShape): GeofenceShape {
  if (shape.kind === "circle") {
    if (!validPoint(shape.center)) throw new TelematicsRuleError("The centre is not on the map");
    if (!Number.isInteger(shape.radiusM) || shape.radiusM < 50 || shape.radiusM > 500_000)
      throw new TelematicsRuleError("The radius is 50 m to 500 km");
    return shape;
  }
  const points = [...shape.points];
  const first = points[0];
  const last = points.at(-1);
  // A closed ring repeats its first point: drop the repeat.
  if (
    first !== undefined &&
    last !== undefined &&
    points.length > 1 &&
    first.latitude === last.latitude &&
    first.longitude === last.longitude
  )
    points.pop();
  if (points.length < 3 || points.length > MAX_POLYGON_POINTS)
    throw new TelematicsRuleError(`A polygon has 3 to ${MAX_POLYGON_POINTS} points`);
  if (!points.every(validPoint)) throw new TelematicsRuleError("A point is not on the map");
  if (Math.abs(ringArea(points)) < 1e-10) throw new TelematicsRuleError("The polygon has no area");
  return { kind: "polygon", points };
}

function ringArea(points: readonly Point[]): number {
  let sum = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++)
    sum +=
      (points[j]!.longitude + points[i]!.longitude) * (points[j]!.latitude - points[i]!.latitude);
  return sum / 2;
}
