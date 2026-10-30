import { z } from "zod";
import type { Reports } from "../../application/use-cases/reporting/Reports.js";
import { REPORT_FORMATS } from "../../domain/reporting/Report.js";
import { principalOf } from "../middleware/AccessGuard.js";
import { envelope } from "../presenters/responseEnvelope.js";
import { defineRoute, type ApiRoute } from "./ApiRoute.js";
import { access } from "./RouteAccess.js";

const uuid = z.uuid();

export type ReportRouteDependencies = Readonly<{ reports: Reports }>;

/**
 * The report engine (docs/14 §7): the catalogue of reports the user may run, running one as JSON
 * (answered at once) or as a CSV, XLSX or PDF file (202: built in the background), and the
 * user's report jobs with a short-lived download link once ready. Each report checks its own
 * permission.
 */
export function reportRoutes(deps: ReportRouteDependencies): ApiRoute[] {
  const { reports } = deps;
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
        params: z.object({ reportId: z.string().regex(/^[a-z][a-z0-9_]{1,79}$/) }),
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
  ];
}
