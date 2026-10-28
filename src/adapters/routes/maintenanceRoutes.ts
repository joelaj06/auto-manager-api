import { z } from "zod";
import type { ServicePlans } from "../../application/use-cases/maintenance/ServicePlans.js";
import type { ServiceSchedule } from "../../application/use-cases/maintenance/ServiceSchedule.js";
import { DUE_STATUSES } from "../../domain/maintenance/ServiceDue.js";
import { PLAN_TARGETS } from "../../domain/maintenance/ServicePlan.js";
import { principalOf } from "../middleware/AccessGuard.js";
import { envelope } from "../presenters/responseEnvelope.js";
import { defineRoute, type ApiRoute } from "./ApiRoute.js";
import { access } from "./RouteAccess.js";

const uuid = z.uuid();
const idParams = z.object({ id: uuid });
const text = (max: number) => z.string().trim().max(max).nullable().optional();
const km = z.number().int().min(0).max(1_000_000);
const days = z.number().int().min(0).max(3_650);

const taskBody = z.object({
  name: z.string().trim().min(1).max(120),
  everyKm: km.min(1).nullable().optional(),
  everyDays: days.min(1).nullable().optional(),
  noticeKm: km.optional(),
  noticeDays: days.optional(),
  graceKm: km.optional(),
  graceDays: days.optional(),
});

const scopeFields = {
  make: text(80),
  model: text(80),
  groupId: uuid.nullable().optional(),
  classId: uuid.nullable().optional(),
  vehicleId: uuid.nullable().optional(),
};

const planBody = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: text(1000),
  appliesTo: z.enum(PLAN_TARGETS),
  ...scopeFields,
  template: z.string().trim().max(40).optional(),
  tasks: z.array(taskBody).min(1).max(50).optional(),
});

const planChange = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: text(1000),
  appliesTo: z.enum(PLAN_TARGETS).optional(),
  ...scopeFields,
  active: z.boolean().optional(),
});

export type MaintenanceRouteDependencies = Readonly<{
  plans: ServicePlans;
  schedule: ServiceSchedule;
}>;

/**
 * Preventive maintenance (docs/12 §2): service plan templates, plans and their tasks, what is
 * due across the fleet and on each vehicle, and services recorded as done.
 */
export function maintenanceRoutes(deps: MaintenanceRouteDependencies): ApiRoute[] {
  const { plans, schedule } = deps;
  const manage = access.permission("maintenance.plans.manage");
  const view = access.permission("maintenance.view");

  return [
    defineRoute({
      method: "get",
      path: "/api/v1/service-plan-templates",
      summary: "Built-in service schedules to start a plan from",
      tags: ["maintenance"],
      access: view,
      responses: { 200: { description: "Templates" } },
      handler: (_input, _req, res) => {
        res.json(envelope(plans.templates()));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/service-plans",
      summary: "Service plans with their tasks",
      tags: ["maintenance"],
      access: view,
      request: {
        query: z.object({
          includeInactive: z
            .enum(["true", "false"])
            .transform((v) => v === "true")
            .default(false),
        }),
      },
      responses: { 200: { description: "Plans" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await plans.list(query.includeInactive)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/service-plans/:id",
      summary: "A service plan with its tasks",
      tags: ["maintenance"],
      access: view,
      request: { params: idParams },
      responses: { 200: { description: "Plan" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await plans.get(params.id)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/service-plans",
      summary:
        "Add a service plan for every vehicle, a make (and model), a group, a rental class or one vehicle — from a template or with its own tasks",
      tags: ["maintenance"],
      access: manage,
      request: { body: planBody },
      responses: { 201: { description: "Plan" } },
      handler: async ({ body }, _req, res) => {
        res.status(201).json(envelope(await plans.create(principalOf(res), body)));
      },
    }),
    defineRoute({
      method: "patch",
      path: "/api/v1/service-plans/:id",
      summary: "Rename, re-target or deactivate a service plan",
      tags: ["maintenance"],
      access: manage,
      request: { params: idParams, body: planChange },
      responses: { 200: { description: "Plan" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await plans.update(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/service-plans/:id/tasks",
      summary: "Add a task (every so many km and/or days) to a service plan",
      tags: ["maintenance"],
      access: manage,
      request: { params: idParams, body: taskBody },
      responses: { 201: { description: "Plan" } },
      handler: async ({ params, body }, _req, res) => {
        res.status(201).json(envelope(await plans.addTask(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "patch",
      path: "/api/v1/service-plan-tasks/:id",
      summary: "Change or deactivate a service plan task",
      tags: ["maintenance"],
      access: manage,
      request: {
        params: idParams,
        body: taskBody.partial().extend({
          position: z.number().int().min(0).max(1_000).optional(),
          active: z.boolean().optional(),
        }),
      },
      responses: { 200: { description: "Plan" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await plans.updateTask(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/service-due",
      summary: "Services coming up, due and overdue across the fleet, most pressing first",
      tags: ["maintenance"],
      access: view,
      request: {
        query: z.object({
          status: z.enum(DUE_STATUSES).optional(),
          branchId: uuid.optional(),
          vehicleId: uuid.optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
        }),
      },
      responses: { 200: { description: "Due services" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await schedule.due(principalOf(res), query)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/vehicles/:id/service-schedule",
      summary: "A vehicle's service plan, every task's next due point and its service history",
      tags: ["maintenance"],
      access: view,
      request: { params: idParams },
      responses: { 200: { description: "Schedule" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await schedule.vehicle(principalOf(res), params.id)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/vehicles/:id/services",
      summary: "Record a service done (the task counts again from it)",
      tags: ["maintenance"],
      access: access.permission("maintenance.work_orders.manage"),
      request: {
        params: idParams,
        body: z.object({
          taskId: uuid,
          doneOn: z.iso.date().optional(),
          odometer: km.nullable().optional(),
          note: text(1000),
          workOrderRef: text(80),
        }),
      },
      responses: { 201: { description: "The record and the vehicle's schedule" } },
      handler: async ({ params, body }, _req, res) => {
        res
          .status(201)
          .json(envelope(await schedule.serviceDone(principalOf(res), params.id, body)));
      },
    }),
  ];
}
