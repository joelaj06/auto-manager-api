import { z } from "zod";
import type { PrintedDocuments } from "../../application/use-cases/documents/PrintedDocuments.js";
import type { DriverApp } from "../../application/use-cases/driverapp/DriverApp.js";
import type { DriverAppAccess } from "../../application/use-cases/parties/DriverAppAccess.js";
import type { VehicleIssues } from "../../application/use-cases/vehicles/VehicleIssues.js";
import { PAYMENT_METHODS } from "../../domain/finance/Payment.js";
import { FILE_KINDS } from "../../domain/files/FileKinds.js";
import { ISSUE_SEVERITIES, ISSUE_TYPES } from "../../domain/vehicles/VehicleIssue.js";
import { principalOf, tenantOf } from "../middleware/AccessGuard.js";
import { sendPdf } from "../presenters/pdfResponse.js";
import { envelope } from "../presenters/responseEnvelope.js";
import { defineRoute, type ApiRoute } from "./ApiRoute.js";
import { access } from "./RouteAccess.js";

const uuid = z.uuid();
const date = z.iso.date();
const idParams = z.object({ id: uuid });
const photoParams = z.object({ id: uuid, fileId: uuid });
const amount = z.string().regex(/^\d{1,13}(\.\d{1,4})?$/, 'Send amounts as text, e.g. "250.00"');
const text = (max: number) => z.string().trim().max(max).nullable().optional();
const period = z.object({ from: date.optional(), to: date.optional() });
const page = z.object({
  cursor: z.string().max(300).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
const declaration = z.object({
  amount,
  method: z.enum(PAYMENT_METHODS),
  momoNetwork: z.enum(["mtn", "telecel", "at"]).nullable().optional(),
  reference: text(100),
  earnings: z
    .record(z.string().max(30), z.number().min(0).max(1_000_000_000))
    .nullable()
    .optional(),
  notes: text(2_000),
});
const issue = z.object({
  type: z.enum(ISSUE_TYPES),
  severity: z.enum(ISSUE_SEVERITIES).optional(),
  canDrive: z.boolean().optional(),
  description: z.string().trim().min(3).max(2_000),
  odometer: z.number().int().min(0).max(5_000_000).nullable().optional(),
  location: text(300),
  occurredAt: z.iso.datetime({ offset: true }).optional(),
});
const photo = z.object({
  filename: z.string().trim().min(1).max(200),
  contentType: z.string().trim().min(3).max(100),
  sizeBytes: z.number().int().min(1).max(FILE_KINDS.vehicle_issue_photo.maxBytes),
});
const issueQuery = page.extend({
  status: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? undefined : v.split(",").map((s) => s.trim())))
    .pipe(z.array(z.enum(["open", "acknowledged", "resolved"])).optional()),
});

const toReport = ({ occurredAt, ...rest }: z.output<typeof issue>) => ({
  ...rest,
  ...(occurredAt === undefined ? {} : { occurredAt: new Date(occurredAt) }),
});

export type DriverAppRouteDependencies = Readonly<{
  app: DriverApp;
  access: DriverAppAccess;
  issues: VehicleIssues;
  printed: PrintedDocuments;
}>;

const DRIVER = access.permission("driver_app.use");

/**
 * The driver app (`/me/driver/…`, Driver role), the staff side of driver logins and vehicle
 * issues, and the receipt and statement PDFs (docs/09 §4, docs/24).
 */
export function driverAppRoutes(deps: DriverAppRouteDependencies): ApiRoute[] {
  const { app, issues, printed } = deps;
  return [
    // --- PDFs (staff) ---
    defineRoute({
      method: "get",
      path: "/api/v1/payments/:id/receipt.pdf",
      summary: "The receipt of money received, as PDF",
      tags: ["finance"],
      access: access.permission("finance.payments.view"),
      request: { params: idParams },
      responses: { 200: { description: "application/pdf" } },
      handler: async ({ params }, _req, res) => {
        sendPdf(res, await printed.receipt(principalOf(res), params.id));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/drivers/:id/ledger/statement.pdf",
      summary: "A driver's statement for a period, as PDF",
      tags: ["remittances"],
      access: access.permission("drivers.ledger.view"),
      request: { params: idParams, query: period },
      responses: { 200: { description: "application/pdf" } },
      handler: async ({ params, query }, _req, res) => {
        sendPdf(res, await printed.driverStatement(principalOf(res), params.id, query));
      },
    }),

    // --- driver logins (staff) ---
    defineRoute({
      method: "get",
      path: "/api/v1/drivers/:id/app-access",
      summary: "Whether the driver has a driver-app login",
      tags: ["drivers"],
      access: access.permission("drivers.app_access.manage"),
      request: { params: idParams },
      responses: { 200: { description: "Access" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await deps.access.status(principalOf(res), params.id)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/drivers/:id/app-access",
      summary: "Give the driver an app login (or a fresh invitation): QR, SMS and email",
      tags: ["drivers"],
      access: access.permission("drivers.app_access.manage"),
      request: { params: idParams },
      responses: { 200: { description: "Access and the invitation" } },
      handler: async ({ params }, _req, res) => {
        res.json(
          envelope(await deps.access.grant(principalOf(res), params.id, tenantOf(res).slug)),
        );
      },
    }),
    defineRoute({
      method: "delete",
      path: "/api/v1/drivers/:id/app-access",
      summary: "Take the driver's app login away (signs them out everywhere)",
      tags: ["drivers"],
      access: access.permission("drivers.app_access.manage"),
      request: { params: idParams },
      responses: { 200: { description: "Access" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await deps.access.revoke(principalOf(res), params.id)));
      },
    }),

    // --- vehicle issues (staff) ---
    defineRoute({
      method: "get",
      path: "/api/v1/vehicle-issues",
      summary: "Issues reported on vehicles in your branches, newest first",
      tags: ["vehicles"],
      access: access.permission("vehicles.issues.view"),
      request: {
        query: issueQuery.extend({
          branchId: uuid.optional(),
          vehicleId: uuid.optional(),
          driverId: uuid.optional(),
        }),
      },
      responses: { 200: { description: "Issues; `meta.nextCursor` for the next page" } },
      handler: async ({ query }, _req, res) => {
        const result = await issues.list(principalOf(res), query);
        res.json(envelope(result.items, { nextCursor: result.nextCursor }));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/vehicles/:id/issues",
      summary: "Log an issue with a vehicle",
      tags: ["vehicles"],
      access: access.permission("vehicles.issues.manage"),
      request: { params: idParams, body: issue.extend({ driverId: uuid.nullable().optional() }) },
      responses: { 201: { description: "Issue" } },
      handler: async ({ params, body }, _req, res) => {
        const { driverId, ...report } = body;
        res.status(201).json(
          envelope(
            await issues.report(principalOf(res), params.id, {
              ...toReport(report),
              driverId: driverId ?? null,
            }),
          ),
        );
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/vehicle-issues/:id",
      summary: "An issue with its photos",
      tags: ["vehicles"],
      access: access.permission("vehicles.issues.view"),
      request: { params: idParams },
      responses: { 200: { description: "Issue" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await issues.get(principalOf(res), params.id)));
      },
    }),
    ...(["acknowledge", "reopen"] as const).map((action) =>
      defineRoute({
        method: "post",
        path: `/api/v1/vehicle-issues/:id/${action}`,
        summary:
          action === "acknowledge"
            ? "Acknowledge an issue (someone is on it)"
            : "Reopen a resolved issue",
        tags: ["vehicles"],
        access: access.permission("vehicles.issues.manage"),
        request: { params: idParams },
        responses: { 200: { description: "Issue" } },
        handler: async ({ params }, _req, res) => {
          res.json(envelope(await issues[action](principalOf(res), params.id)));
        },
      }),
    ),
    defineRoute({
      method: "post",
      path: "/api/v1/vehicle-issues/:id/resolve",
      summary: "Resolve an issue with what was done",
      tags: ["vehicles"],
      access: access.permission("vehicles.issues.manage"),
      request: {
        params: idParams,
        body: z.object({ resolution: z.string().trim().min(3).max(2_000) }),
      },
      responses: { 200: { description: "Issue" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await issues.resolve(principalOf(res), params.id, body.resolution)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/vehicle-issues/:id/photos",
      summary: "Attach a photo to an issue",
      tags: ["vehicles"],
      access: access.permission("vehicles.issues.manage"),
      request: { params: idParams, body: photo },
      responses: { 201: { description: "Upload URL" } },
      handler: async ({ params, body }, _req, res) => {
        res.status(201).json(envelope(await issues.startPhoto(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/vehicle-issues/:id/photos/:fileId/complete",
      summary: "Confirm an issue photo upload",
      tags: ["vehicles"],
      access: access.permission("vehicles.issues.manage"),
      request: { params: photoParams },
      responses: { 200: { description: "Photo" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await issues.completePhoto(principalOf(res), params.id, params.fileId)));
      },
    }),

    // --- the driver app ---
    defineRoute({
      method: "get",
      path: "/api/v1/me/driver",
      summary: "Driver app home: me, my vehicle and terms, my balance and open remittances",
      tags: ["driver-app"],
      access: DRIVER,
      responses: { 200: { description: "Home" }, 404: { description: "No driver profile" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await app.home(principalOf(res))));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/me/driver/workpay",
      summary: "My work and pay agreements with their schedules",
      tags: ["driver-app"],
      access: DRIVER,
      responses: { 200: { description: "Agreements" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await app.workpay(principalOf(res))));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/me/driver/vehicle",
      summary: "The vehicle I drive, with its documents' compliance",
      tags: ["driver-app"],
      access: DRIVER,
      responses: { 200: { description: "Vehicle" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await app.vehicle(principalOf(res))));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/me/driver/ledger",
      summary: "My statement: opening, lines, closing balance and shortfalls",
      tags: ["driver-app"],
      access: DRIVER,
      request: { query: period },
      responses: { 200: { description: "Statement" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await app.ledger(principalOf(res), query)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/me/driver/ledger/statement.pdf",
      summary: "My statement as PDF",
      tags: ["driver-app"],
      access: DRIVER,
      request: { query: period },
      responses: { 200: { description: "application/pdf" } },
      handler: async ({ query }, _req, res) => {
        sendPdf(res, await app.statementPdf(principalOf(res), query));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/me/driver/payments/:id/receipt.pdf",
      summary: "The receipt of one of my payments, as PDF",
      tags: ["driver-app"],
      access: DRIVER,
      request: { params: idParams },
      responses: { 200: { description: "application/pdf" } },
      handler: async ({ params }, _req, res) => {
        sendPdf(res, await app.receiptPdf(principalOf(res), params.id));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/me/driver/remittances",
      summary: "My remittance periods, latest first",
      tags: ["driver-app"],
      access: DRIVER,
      request: { query: page },
      responses: { 200: { description: "Remittances; `meta.nextCursor` for the next page" } },
      handler: async ({ query }, _req, res) => {
        const result = await app.remittances(principalOf(res), query);
        res.json(envelope(result.items, { nextCursor: result.nextCursor }));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/me/driver/remittances/declare",
      summary: "Declare a period of my vehicle (variable remittance)",
      tags: ["driver-app"],
      access: DRIVER,
      request: { body: declaration.extend({ periodStart: date, periodEnd: date }) },
      responses: { 201: { description: "Remittance waiting for approval" } },
      handler: async ({ body }, _req, res) => {
        res.status(201).json(envelope(await app.declarePeriod(principalOf(res), body)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/me/driver/remittances/:id",
      summary: "One of my remittance periods with its declarations",
      tags: ["driver-app"],
      access: DRIVER,
      request: { params: idParams },
      responses: { 200: { description: "Remittance" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await app.remittance(principalOf(res), params.id)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/me/driver/remittances/:id/submissions",
      summary: "Declare what I paid for a period (waits for approval)",
      tags: ["driver-app"],
      access: DRIVER,
      request: { params: idParams, body: declaration },
      responses: { 201: { description: "Remittance" } },
      handler: async ({ params, body }, _req, res) => {
        res.status(201).json(envelope(await app.declare(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/me/driver/fuel",
      summary: "Log a fuel fill of my vehicle (paid by me: the business owes me once approved)",
      tags: ["driver-app"],
      access: DRIVER,
      request: {
        body: z.object({
          litres: z.string().regex(/^\d{1,4}(\.\d{1,2})?$/, 'Litres, e.g. "42.5"'),
          amount,
          odometer: z.number().int().min(0).max(5_000_000),
          fullTank: z.boolean().optional(),
          filledAt: z.iso.datetime({ offset: true }).optional(),
          station: text(120),
          paidByDriver: z.boolean().default(false),
          notes: text(2_000),
        }),
      },
      responses: { 201: { description: "Fuel log and its expense" } },
      handler: async ({ body }, _req, res) => {
        const { filledAt, ...input } = body;
        res.status(201).json(
          envelope(
            await app.fuel(principalOf(res), {
              ...input,
              ...(filledAt === undefined ? {} : { filledAt: new Date(filledAt) }),
            }),
          ),
        );
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/me/driver/issues",
      summary: "Report an issue with my vehicle (breakdown, accident, damage …)",
      tags: ["driver-app"],
      access: DRIVER,
      request: { body: issue },
      responses: { 201: { description: "Issue" } },
      handler: async ({ body }, _req, res) => {
        res.status(201).json(envelope(await app.reportIssue(principalOf(res), toReport(body))));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/me/driver/issues",
      summary: "Issues I reported, newest first",
      tags: ["driver-app"],
      access: DRIVER,
      request: { query: issueQuery },
      responses: { 200: { description: "Issues" } },
      handler: async ({ query }, _req, res) => {
        const result = await app.issues(principalOf(res), query);
        res.json(envelope(result.items, { nextCursor: result.nextCursor }));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/me/driver/issues/:id",
      summary: "One of my issue reports with its photos",
      tags: ["driver-app"],
      access: DRIVER,
      request: { params: idParams },
      responses: { 200: { description: "Issue" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await app.issue(principalOf(res), params.id)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/me/driver/issues/:id/photos",
      summary: "Add a photo to my issue report",
      tags: ["driver-app"],
      access: DRIVER,
      request: { params: idParams, body: photo },
      responses: { 201: { description: "Upload URL" } },
      handler: async ({ params, body }, _req, res) => {
        res
          .status(201)
          .json(envelope(await app.startIssuePhoto(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/me/driver/issues/:id/photos/:fileId/complete",
      summary: "Confirm a photo upload of my issue report",
      tags: ["driver-app"],
      access: DRIVER,
      request: { params: photoParams },
      responses: { 200: { description: "Photo" } },
      handler: async ({ params }, _req, res) => {
        res.json(
          envelope(await app.completeIssuePhoto(principalOf(res), params.id, params.fileId)),
        );
      },
    }),
  ];
}
