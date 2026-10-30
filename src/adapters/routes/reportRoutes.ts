import { z } from "zod";
import type { ReportSchedules } from "../../application/use-cases/reporting/ReportSchedules.js";
import type { Reports } from "../../application/use-cases/reporting/Reports.js";
import { FILE_FORMATS, REPORT_FORMATS } from "../../domain/reporting/Report.js";
import {
  MAX_RECIPIENTS,
  SCHEDULE_FREQUENCIES,
  SCHEDULE_PERIODS,
} from "../../domain/reporting/ReportSchedule.js";
import { principalOf } from "../middleware/AccessGuard.js";
import { envelope } from "../presenters/responseEnvelope.js";
import { defineRoute, type ApiRoute } from "./ApiRoute.js";
import { access } from "./RouteAccess.js";

const uuid = z.uuid();
const reportId = z.string().regex(/^[a-z][a-z0-9_]{1,79}$/);

const schedule = z.object({
  name: z.string().trim().min(1).max(120),
  reportId,
  params: z.record(z.string(), z.unknown()).default({}),
  /** Worked out on the run day and put into the report's from/to, asOf or month. */
  period: z.enum(SCHEDULE_PERIODS).nullable().default(null),
  format: z.enum(FILE_FORMATS),
  frequency: z.enum(SCHEDULE_FREQUENCIES),
  weekday: z.number().int().min(1).max(7).nullable().default(null),
  monthDay: z.number().int().min(1).max(28).nullable().default(null),
  hour: z.number().int().min(0).max(23),
  recipients: z.array(uuid).min(1).max(MAX_RECIPIENTS),
});

export type ReportRouteDependencies = Readonly<{ reports: Reports; schedules: ReportSchedules }>;

/**
 * The report engine (docs/14 §7): the catalogue of reports the user may run, running one as JSON
 * (answered at once) or as a CSV, XLSX or PDF file (202: built in the background), and the
 * user's report jobs with a short-lived download link once ready. Each report checks its own
 * permission.
 */
export function reportRoutes(deps: ReportRouteDependencies): ApiRoute[] {
  const { reports, schedules } = deps;
  const manage = access.permission("reports.schedules.manage");
  const tags = ["reports"];

  return [
    defineRoute({
      method: "get",
      path: "/api/v1/reports",
      summary: "The reports you may run, with their parameters and formats",
      tags,
      access: access.signedIn(),
      responses: { 200: { description: "Catalogue" } },
      handler: (_input, _req, res) => {
        res.json(envelope(reports.catalogue(principalOf(res))));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/reports/:reportId/run",
      summary:
        "Run a report: JSON is answered at once; CSV, XLSX and PDF are built in the background (202 with the job)",
      tags,
      access: access.signedIn(),
      request: {
        params: z.object({ reportId }),
        body: z.object({
          params: z.record(z.string(), z.unknown()).optional(),
          format: z.enum(REPORT_FORMATS).default("json"),
        }),
      },
      responses: {
        200: { description: "The report (JSON)" },
        202: { description: "The report job (files)" },
      },
      handler: async ({ params, body }, _req, res) => {
        const result = await reports.run(principalOf(res), params.reportId, {
          params: body.params ?? {},
          format: body.format,
        });
        if (result.kind === "table") res.json(envelope(result.table));
        else res.status(202).json(envelope(result.job));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/reports/jobs",
      summary: "Your report files, newest first",
      tags,
      access: access.signedIn(),
      responses: { 200: { description: "Report jobs" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await reports.jobs(principalOf(res))));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/reports/jobs/:id",
      summary: "One of your report files: its status and, once ready, a short-lived download link",
      tags,
      access: access.signedIn(),
      request: { params: z.object({ id: uuid }) },
      responses: { 200: { description: "Report job" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await reports.jobFor(principalOf(res), params.id)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/reports/schedules",
      summary: "Report schedules: yours, or all with the all scope",
      tags,
      access: manage,
      responses: { 200: { description: "Report schedules" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await schedules.list(principalOf(res))));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/reports/schedules",
      summary:
        "Send a report on a schedule: built daily, weekly or monthly at a local hour as you, to up to 20 users who may run it",
      tags,
      access: manage,
      request: { body: schedule },
      responses: { 201: { description: "Report schedule" } },
      handler: async ({ body }, _req, res) => {
        res.status(201).json(envelope(await schedules.create(principalOf(res), body)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/reports/schedules/:id",
      summary: "One report schedule",
      tags,
      access: manage,
      request: { params: z.object({ id: uuid }) },
      responses: { 200: { description: "Report schedule" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await schedules.get(principalOf(res), params.id)));
      },
    }),
    defineRoute({
      method: "put",
      path: "/api/v1/reports/schedules/:id",
      summary: "Change a report schedule (it still runs as its owner)",
      tags,
      access: manage,
      request: { params: z.object({ id: uuid }), body: schedule },
      responses: { 200: { description: "Report schedule" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await schedules.change(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/reports/schedules/:id/pause",
      summary: "Pause a report schedule",
      tags,
      access: manage,
      request: { params: z.object({ id: uuid }) },
      responses: { 200: { description: "Report schedule" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await schedules.pause(principalOf(res), params.id)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/reports/schedules/:id/resume",
      summary: "Resume a paused report schedule from its next run day",
      tags,
      access: manage,
      request: { params: z.object({ id: uuid }) },
      responses: { 200: { description: "Report schedule" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await schedules.resume(principalOf(res), params.id)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/reports/schedules/:id/run",
      summary: "Build and send a scheduled report now (the next run stays)",
      tags,
      access: manage,
      request: { params: z.object({ id: uuid }) },
      responses: { 202: { description: "Report schedule with the run's job" } },
      handler: async ({ params }, _req, res) => {
        res.status(202).json(envelope(await schedules.runNow(principalOf(res), params.id)));
      },
    }),
    defineRoute({
      method: "delete",
      path: "/api/v1/reports/schedules/:id",
      summary: "Remove a report schedule (runs already sent stay until they expire)",
      tags,
      access: manage,
      request: { params: z.object({ id: uuid }) },
      responses: { 204: { description: "Removed" } },
      handler: async ({ params }, _req, res) => {
        await schedules.remove(principalOf(res), params.id);
        res.status(204).end();
      },
    }),
  ];
}
