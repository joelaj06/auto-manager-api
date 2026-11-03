import { describe, expect, it } from "vitest";
import { MAX_POSITIONS_PER_REQUEST, parsePositions } from "./providerPayloads.js";

describe("provider payloads", () => {
  it("reads our own format", () => {
    const { positions, rejected } = parsePositions("generic", {
      positions: [
        {
          deviceId: "IMEI-1",
          recordedAt: "2026-11-03T08:00:00Z",
          latitude: 5.6052,
          longitude: -0.1668,
          speedKmh: 42.36,
          heading: 370,
          ignition: true,
          odometerKm: 12_345.67,
        },
        { deviceId: "IMEI-1", recordedAt: "nonsense", latitude: 5.6, longitude: -0.1 },
        { deviceId: "IMEI-1", recordedAt: 1_793_000_000, latitude: 0, longitude: 0 },
      ],
    });
    expect(rejected).toBe(2);
    expect(positions[0]).toMatchObject({
      identifier: "IMEI-1",
      fix: { speedKmh: 42.4, heading: 10, ignition: true, odometerKm: 12_345.7 },
    });
  });

  it("reads flespi messages", () => {
    const { positions } = parsePositions("flespi", [
      {
        ident: "352093081234567",
        timestamp: 1_793_001_234.5,
        "position.latitude": 5.55,
        "position.longitude": -0.2,
        "position.speed": 61,
        "position.direction": 180,
        "engine.ignition.status": false,
        "vehicle.mileage": 8_000.5,
        "battery.voltage": 4.1,
      },
    ]);
    expect(positions[0]).toMatchObject({
      identifier: "352093081234567",
      fix: { speedKmh: 61, ignition: false, odometerKm: 8_000.5 },
      attributes: { "battery.voltage": 4.1 },
    });
    expect(positions[0]!.fix.recordedAt.toISOString()).toBe("2026-10-26T07:53:54.500Z");
  });

  it("reads Traccar forwarding with speed in knots and distance in metres", () => {
    const { positions } = parsePositions("traccar", {
      position: {
        fixTime: "2026-11-03T08:00:00.000+00:00",
        latitude: 5.6,
        longitude: -0.18,
        speed: 10,
        course: 45,
        attributes: { ignition: true, totalDistance: 1_234_500, batteryLevel: 80 },
      },
      device: { uniqueId: "T-77", name: "GT-123-26" },
    });
    expect(positions[0]).toMatchObject({
      identifier: "T-77",
      fix: { speedKmh: 18.5, ignition: true, odometerKm: 1_234.5, heading: 45 },
      attributes: { batteryLevel: 80 },
    });
  });

  it("takes at most a thousand positions a request", () => {
    const many = Array.from({ length: MAX_POSITIONS_PER_REQUEST + 5 }, (_, i) => ({
      deviceId: "X",
      recordedAt: 1_793_000_000 + i,
      latitude: 5.6,
      longitude: -0.2,
    }));
    const { positions, rejected } = parsePositions("generic", many);
    expect(positions).toHaveLength(MAX_POSITIONS_PER_REQUEST);
    expect(rejected).toBe(5);
  });
});
