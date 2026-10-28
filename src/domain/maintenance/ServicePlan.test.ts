import { describe, expect, it } from "vitest";
import {
  checkTask,
  planFor,
  planScope,
  SERVICE_TEMPLATES,
  ServicePlanError,
  type PlanScope,
} from "./ServicePlan.js";

const plan = (id: string, scope: Partial<PlanScope> & Pick<PlanScope, "appliesTo">, at = 1) => ({
  id,
  active: true,
  createdAt: new Date(at),
  ...planScope(scope),
});

const corolla = {
  vehicleId: "v1",
  make: "Toyota",
  model: "Corolla",
  groupIds: ["g1"],
  classId: "c1",
};

describe("service plans", () => {
  it("keeps only the fields of the plan's target, and needs them", () => {
    expect(planScope({ appliesTo: "all", make: "Toyota", vehicleId: "v1" })).toEqual({
      appliesTo: "all",
      make: null,
      model: null,
      groupId: null,
      classId: null,
      vehicleId: null,
    });
    expect(() => planScope({ appliesTo: "make_model", make: "  " })).toThrow(ServicePlanError);
    expect(() => planScope({ appliesTo: "vehicle_group" })).toThrow("needs groupId");
  });

  it("follows the most specific active plan, the newest on a tie", () => {
    const plans = [
      plan("all", { appliesTo: "all" }),
      plan("class", { appliesTo: "rental_class", classId: "c1" }),
      plan("group", { appliesTo: "vehicle_group", groupId: "g1" }),
      plan("make", { appliesTo: "make_model", make: "toyota" }),
      plan("model", { appliesTo: "make_model", make: "Toyota", model: "corolla" }),
      plan("other", { appliesTo: "make_model", make: "Nissan" }),
    ];
    expect(planFor(plans, corolla)?.id).toBe("model");
    expect(planFor(plans.slice(0, 4), corolla)?.id).toBe("make");
    expect(planFor(plans.slice(0, 3), corolla)?.id).toBe("group");
    expect(planFor(plans.slice(0, 2), corolla)?.id).toBe("class");
    expect(
      planFor([...plans, plan("mine", { appliesTo: "vehicle", vehicleId: "v1" })], corolla)?.id,
    ).toBe("mine");
    expect(
      planFor([plan("a", { appliesTo: "all" }, 1), plan("b", { appliesTo: "all" }, 2)], corolla)
        ?.id,
    ).toBe("b");
    expect(planFor([{ ...plan("off", { appliesTo: "all" }), active: false }], corolla)).toBeNull();
    expect(
      planFor([plan("other", { appliesTo: "make_model", make: "Nissan" })], corolla),
    ).toBeNull();
  });

  it("checks task intervals", () => {
    const task = {
      name: "Oil",
      everyKm: 5_000,
      everyDays: null,
      noticeKm: 1_000,
      noticeDays: 14,
      graceKm: 500,
      graceDays: 7,
    };
    expect(() => checkTask(task)).not.toThrow();
    expect(() => checkTask({ ...task, everyKm: null })).toThrow("every how many km or days");
    expect(() => checkTask({ ...task, noticeKm: 5_000 })).toThrow("shorter than the interval");
  });

  it("ships templates whose tasks pass the checks", () => {
    for (const template of Object.values(SERVICE_TEMPLATES))
      for (const t of template.tasks)
        expect(() =>
          checkTask({
            name: t.name,
            everyKm: t.everyKm ?? null,
            everyDays: t.everyDays ?? null,
            noticeKm: Math.min(t.noticeKm ?? 1_000, (t.everyKm ?? 5_000) / 5),
            noticeDays: Math.min(t.noticeDays ?? 14, Math.floor((t.everyDays ?? 70) / 5)),
            graceKm: 500,
            graceDays: 7,
          }),
        ).not.toThrow();
  });
});
