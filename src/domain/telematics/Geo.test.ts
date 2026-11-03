import { describe, expect, it } from "vitest";
import { checkGeofenceShape, contains, distanceMeters, insidePolygon } from "./Geo.js";

// Accra: Kotoka airport and Independence Square.
const airport = { latitude: 5.6052, longitude: -0.1668 };
const square = { latitude: 5.5469, longitude: -0.1918 };

describe("geography", () => {
  it("measures great-circle distances", () => {
    expect(distanceMeters(airport, square)).toBeGreaterThan(6_900);
    expect(distanceMeters(airport, square)).toBeLessThan(7_100);
    expect(distanceMeters(airport, airport)).toBe(0);
  });

  it("finds points in polygons and circles", () => {
    const box = [
      { latitude: 5.5, longitude: -0.25 },
      { latitude: 5.5, longitude: -0.15 },
      { latitude: 5.65, longitude: -0.15 },
      { latitude: 5.65, longitude: -0.25 },
    ];
    expect(insidePolygon(airport, box)).toBe(true);
    expect(insidePolygon({ latitude: 6.7, longitude: -1.6 }, box)).toBe(false); // Kumasi
    expect(contains({ kind: "circle", center: airport, radiusM: 1_000 }, airport)).toBe(true);
    expect(contains({ kind: "circle", center: airport, radiusM: 1_000 }, square)).toBe(false);
  });

  it("checks shapes", () => {
    expect(() => checkGeofenceShape({ kind: "circle", center: airport, radiusM: 10 })).toThrow(
      /50 m/,
    );
    expect(() =>
      checkGeofenceShape({ kind: "polygon", points: [airport, square, airport] }),
    ).toThrow(/3 to 200/);
    expect(() =>
      checkGeofenceShape({
        kind: "polygon",
        points: [airport, square, { latitude: 5.4886, longitude: -0.2168 }],
      }),
    ).toThrow(/no area/);
    const closed = checkGeofenceShape({
      kind: "polygon",
      points: [
        { latitude: 5.5, longitude: -0.25 },
        { latitude: 5.5, longitude: -0.15 },
        { latitude: 5.65, longitude: -0.15 },
        { latitude: 5.5, longitude: -0.25 },
      ],
    });
    expect(closed.kind === "polygon" && closed.points).toHaveLength(3);
  });
});
