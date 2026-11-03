import { describe, expect, it } from "vitest";
import {
  checkTemplate,
  doneByProgress,
  planTasks,
  type TaskTemplate,
} from "./OnboardingConcierge.js";

const template = (
  key: string,
  position: number,
  extra: Partial<TaskTemplate> = {},
): TaskTemplate => ({
  key,
  title: key,
  description: null,
  dueAfterHours: 24,
  completesWith: null,
  position,
  active: true,
  ...extra,
});

describe("onboarding concierge", () => {
  it("plans the active templates in order, due after provisioning", () => {
    const provisionedAt = new Date("2026-11-03T10:00:00Z");
    const tasks = planTasks(
      [
        template("vehicles_imported", 2, { dueAfterHours: 72, completesWith: "vehicle_added" }),
        template("welcome_call", 1),
        template("retired", 0, { active: false }),
      ],
      provisionedAt,
    );
    expect(tasks.map((t) => t.templateKey)).toEqual(["welcome_call", "vehicles_imported"]);
    expect(tasks[1]!.dueAt).toEqual(new Date("2026-11-06T10:00:00Z"));
  });

  it("finds the tasks the tenant's milestones have done", () => {
    const tasks = [
      { id: "a", completesWith: "vehicle_added" },
      { id: "b", completesWith: "driver_added" },
      { id: "c", completesWith: null },
    ];
    expect(doneByProgress(tasks, { vehicle_added: "2026-11-03" }).map((t) => t.id)).toEqual(["a"]);
  });

  it("checks templates", () => {
    expect(() => checkTemplate({ dueAfterHours: 0, completesWith: null })).toThrow(/1 hour/);
    expect(() => checkTemplate({ dueAfterHours: 24, completesWith: "nope" })).toThrow(/Unknown/);
    expect(() => checkTemplate({ dueAfterHours: 24, completesWith: "first_rental" })).not.toThrow();
  });
});
