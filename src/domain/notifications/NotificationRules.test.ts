import { describe, expect, it } from "vitest";
import {
  quietDelay,
  quietHours,
  reminderThreshold,
  renderTemplate,
  RULES,
  ruleConfig,
  senderId,
} from "./NotificationRules.js";

const at = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));

describe("quiet hours", () => {
  const night = { start: "21:00", end: "07:00" };

  it("hold SMS until the window ends, across midnight", () => {
    expect(quietDelay(at("20:59"), night)).toBe(0);
    expect(quietDelay(at("21:00"), night)).toBe(600);
    expect(quietDelay(at("23:30"), night)).toBe(450);
    expect(quietDelay(at("06:59"), night)).toBe(1);
    expect(quietDelay(at("07:00"), night)).toBe(0);
  });

  it("work within one day and can be switched off", () => {
    expect(quietDelay(at("13:30"), { start: "13:00", end: "14:00" })).toBe(30);
    expect(quietDelay(at("23:00"), null)).toBe(0);
    expect(() => quietHours({ start: "9:00", end: "07:00" })).toThrow(/HH:MM/);
    expect(() => quietHours({ start: "07:00", end: "07:00" })).toThrow(/length/);
  });
});

describe("rule configuration", () => {
  it("keeps only channels, days and placeholders the rule allows", () => {
    expect(
      ruleConfig("driver_licence_expiry", {
        enabled: true,
        channels: ["sms", "in_app", "sms"],
        daysBefore: [7, 60, 7],
        smsTemplate: "  {{driverName}}: licence ends {{expiresOn}}  ",
      }),
    ).toEqual({
      enabled: true,
      channels: ["sms", "in_app"],
      daysBefore: [60, 7],
      smsTemplate: "{{driverName}}: licence ends {{expiresOn}}",
    });
    expect(() => ruleConfig("budget_threshold", { enabled: true, channels: ["sms"] })).toThrow(
      /cannot use the sms channel/,
    );
    expect(() =>
      ruleConfig("vehicle_document_expiry", { enabled: true, channels: [], daysBefore: [400] }),
    ).toThrow(/0 to 365/);
    expect(() =>
      ruleConfig("remittance_due", {
        enabled: true,
        channels: ["sms"],
        smsTemplate: "Pay {{amount}} to {{momoNumber}}",
      }),
    ).toThrow(/Unknown placeholder \{\{momoNumber\}\}/);
  });

  it("has valid defaults for every rule", () => {
    for (const [key, rule] of Object.entries(RULES))
      expect(() => ruleConfig(key as keyof typeof RULES, rule.defaults)).not.toThrow();
  });
});

describe("texts", () => {
  it("fill placeholders", () => {
    expect(
      renderTemplate("Hi {{ driverName }}, pay {{amount}} {{unknown}}", {
        driverName: "Ama",
        amount: "GHS 250.00",
      }),
    ).toBe("Hi Ama, pay GHS 250.00 {{unknown}}");
  });

  it("accept Sender IDs networks allow", () => {
    expect(senderId(" AutoFleet ")).toBe("AutoFleet");
    expect(() => senderId("AB")).toThrow(/3 to 11/);
    expect(() => senderId("1Fleet")).toThrow(/starting with a letter/);
    expect(() => senderId("FleetManagerGH")).toThrow(/3 to 11/);
  });
});

describe("reminder thresholds", () => {
  it("remind at the nearest configured day, catching up a missed run", () => {
    const days = [30, 14, 3, 0];
    expect(reminderThreshold(31, days)).toBeNull();
    expect(reminderThreshold(30, days)).toBe(30);
    expect(reminderThreshold(13, days)).toBe(14);
    expect(reminderThreshold(0, days)).toBe(0);
    expect(reminderThreshold(-1, days)).toBeNull();
  });
});
