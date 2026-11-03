import type { ReceivedPosition, TelematicsProvider } from "../../application/ports/ITelematics.js";

/** At most this many positions in one request. */
export const MAX_POSITIONS_PER_REQUEST = 1_000;

export type ParsedPayload = Readonly<{ positions: ReceivedPosition[]; rejected: number }>;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
};
const bool = (v: unknown): boolean | null => {
  if (typeof v === "boolean") return v;
  if (v === 1 || v === "1" || v === "true") return true;
  if (v === 0 || v === "0" || v === "false") return false;
  return null;
};
const text = (v: unknown): string | null =>
  typeof v === "string" && v.trim() !== "" ? v.trim() : typeof v === "number" ? String(v) : null;

/** ISO text, or seconds (or milliseconds) since 1970. */
function time(v: unknown): Date | null {
  if (typeof v === "string" && !/^\d+(\.\d+)?$/.test(v.trim())) {
    const at = new Date(v);
    return Number.isNaN(at.getTime()) ? null : at;
  }
  const n = num(v);
  if (n === null) return null;
  const at = new Date(n > 1e12 ? n : n * 1000);
  return Number.isNaN(at.getTime()) ? null : at;
}

function position(
  identifier: string | null,
  fields: Readonly<{
    recordedAt: unknown;
    latitude: unknown;
    longitude: unknown;
    speedKmh: number | null;
    heading: unknown;
    ignition: unknown;
    odometerKm: number | null;
  }>,
  attributes: Obj,
): ReceivedPosition | null {
  const recordedAt = time(fields.recordedAt);
  const latitude = num(fields.latitude);
  const longitude = num(fields.longitude);
  if (identifier === null || recordedAt === null || latitude === null || longitude === null)
    return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  // No fix: providers send 0,0 when the tracker has no satellites.
  if (latitude === 0 && longitude === 0) return null;
  const heading = num(fields.heading);
  return {
    identifier: identifier.slice(0, 64),
    fix: {
      recordedAt,
      latitude: Math.round(latitude * 1e6) / 1e6,
      longitude: Math.round(longitude * 1e6) / 1e6,
      speedKmh: Math.max(0, Math.round((fields.speedKmh ?? 0) * 10) / 10),
      heading: heading === null ? null : Math.round(((heading % 360) + 360) % 360) % 360,
      ignition: bool(fields.ignition),
      odometerKm:
        fields.odometerKm === null || fields.odometerKm < 0
          ? null
          : Math.round(fields.odometerKm * 10) / 10,
    },
    attributes,
  };
}

/** Our own format: `{ positions: [...] }`, an array, or one position. */
function generic(item: Obj): ReceivedPosition | null {
  const attributes = isObj(item.attributes) ? item.attributes : {};
  return position(
    text(item.deviceId ?? item.identifier),
    {
      recordedAt: item.recordedAt ?? item.timestamp,
      latitude: item.latitude,
      longitude: item.longitude,
      speedKmh: num(item.speedKmh),
      heading: item.heading,
      ignition: item.ignition,
      odometerKm: num(item.odometerKm),
    },
    attributes,
  );
}

/** A flespi message (HTTP stream): flat keys such as `position.latitude` and `ident`. */
function flespi(item: Obj): ReceivedPosition | null {
  const keep: Obj = {};
  for (const key of ["battery.voltage", "external.powersource.voltage", "gnss.satellites.count"])
    if (item[key] !== undefined) keep[key] = item[key];
  return position(
    text(item.ident),
    {
      recordedAt: item.timestamp,
      latitude: item["position.latitude"],
      longitude: item["position.longitude"],
      speedKmh: num(item["position.speed"]),
      heading: item["position.direction"],
      ignition: item["engine.ignition.status"],
      odometerKm: num(item["vehicle.mileage"]),
    },
    keep,
  );
}

/** Traccar's position forwarding: `{ position, device }`, speed in knots, distances in metres. */
function traccar(item: Obj): ReceivedPosition | null {
  const p = isObj(item.position) ? item.position : item;
  const device = isObj(item.device) ? item.device : {};
  const attributes = isObj(p.attributes) ? p.attributes : {};
  const knots = num(p.speed);
  const metres = num(attributes.odometer) ?? num(attributes.totalDistance);
  const keep: Obj = {};
  for (const key of ["batteryLevel", "power", "sat", "motion"])
    if (attributes[key] !== undefined) keep[key] = attributes[key];
  return position(
    text(device.uniqueId ?? p.uniqueId ?? p.deviceId),
    {
      recordedAt: p.fixTime ?? p.deviceTime,
      latitude: p.latitude,
      longitude: p.longitude,
      speedKmh: knots === null ? null : knots * 1.852,
      heading: p.course,
      ignition: attributes.ignition,
      odometerKm: metres === null ? null : metres / 1000,
    },
    keep,
  );
}

const PARSERS: Readonly<Record<TelematicsProvider, (item: Obj) => ReceivedPosition | null>> = {
  generic,
  flespi,
  traccar,
};

/** The items of a request body: an array, `{ positions }`, `{ result }`, or one item. */
function itemsOf(body: unknown): unknown[] {
  if (Array.isArray(body)) return body;
  if (isObj(body)) {
    if (Array.isArray(body.positions)) return body.positions;
    if (Array.isArray(body.result)) return body.result;
    return [body];
  }
  return [];
}

/** Reads a provider's request body; items that are not a usable position are counted. */
export function parsePositions(provider: TelematicsProvider, body: unknown): ParsedPayload {
  const all = itemsOf(body);
  const items = all.slice(0, MAX_POSITIONS_PER_REQUEST);
  const positions: ReceivedPosition[] = [];
  let rejected = all.length - items.length;
  for (const item of items) {
    const parsed = isObj(item) ? PARSERS[provider](item) : null;
    if (parsed === null) rejected += 1;
    else positions.push(parsed);
  }
  return { positions, rejected };
}
