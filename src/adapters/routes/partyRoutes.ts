import { z } from "zod";
import type { PermissionKey } from "../../application/authorization/permissionCatalog.js";
import { PARTY_DOCUMENT_TYPES } from "../../application/ports/IPartyRecords.js";
import type { CustomerAdministration } from "../../application/use-cases/parties/CustomerAdministration.js";
import {
  DRIVER_ACTIONS,
  type DriverAction,
  type DriverAdministration,
} from "../../application/use-cases/parties/DriverAdministration.js";
import type { DriverGuarantors } from "../../application/use-cases/parties/DriverGuarantors.js";
import type { DriverSettingsService } from "../../application/use-cases/parties/DriverSettingsService.js";
import type {
  PartyDocuments,
  PartyRef,
} from "../../application/use-cases/parties/PartyDocuments.js";
import type { SupplierAdministration } from "../../application/use-cases/parties/SupplierAdministration.js";
import { FILE_KINDS } from "../../domain/files/FileKinds.js";
import { CUSTOMER_SOURCES, CUSTOMER_TYPES, RISK_STATUSES } from "../../domain/parties/Customer.js";
import { DRIVER_STATUSES, EMPLOYMENT_TYPES } from "../../domain/parties/Driver.js";
import { LICENCE_CLASSES, MOMO_NETWORKS } from "../../domain/parties/PartyDetails.js";
import { SUPPLIER_TYPES } from "../../domain/parties/Supplier.js";
import { principalOf } from "../middleware/AccessGuard.js";
import { envelope } from "../presenters/responseEnvelope.js";
import { defineRoute, type ApiRoute } from "./ApiRoute.js";
import { access } from "./RouteAccess.js";

const uuid = z.uuid();
const date = z.iso.date();
const text = (max: number) => z.string().trim().max(max).nullable().optional();
const phone = z.string().trim().min(6).max(25);
const reason = z.string().trim().min(3).max(500);
const amount = z.string().regex(/^\d{1,13}(\.\d{1,4})?$/, 'Send amounts as text, e.g. "5000.00"');
const tags = z.array(z.string().trim().min(1).max(40)).max(20).optional();
const idParams = z.object({ id: uuid });
const page = {
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
};

const payout = z
  .object({
    momoNumber: phone.nullable().optional(),
    momoNetwork: z.enum(MOMO_NETWORKS).nullable().optional(),
    momoName: text(120),
    bankName: text(120),
    bankBranch: text(120),
    accountName: text(120),
    accountNumber: text(34),
  })
  .transform((p) => ({
    momoNumber: p.momoNumber ?? null,
    momoNetwork: p.momoNetwork ?? null,
    momoName: p.momoName ?? null,
    bankName: p.bankName ?? null,
    bankBranch: p.bankBranch ?? null,
    accountName: p.accountName ?? null,
    accountNumber: p.accountNumber ?? null,
  }));

const driverFields = {
  firstName: z.string().trim().min(1).max(80).optional(),
  lastName: z.string().trim().min(1).max(80).optional(),
  otherNames: text(80),
  phone: phone.optional(),
  altPhone: phone.nullable().optional(),
  email: text(254),
  dateOfBirth: date.nullable().optional(),
  gender: z.enum(["female", "male"]).nullable().optional(),
  address: text(300),
  ghanaCardNumber: text(20),
  licenceNumber: text(30),
  licenceClass: z.enum(LICENCE_CLASSES).nullable().optional(),
  licenceIssuedOn: date.nullable().optional(),
  licenceExpiresOn: date.nullable().optional(),
  employmentType: z.enum(EMPLOYMENT_TYPES).optional(),
  hiredOn: date.nullable().optional(),
  emergencyContact: z
    .object({ name: z.string().trim().min(1).max(120), phone, relationship: text(60) })
    .transform((c) => ({ ...c, relationship: c.relationship ?? null }))
    .nullable()
    .optional(),
  payout: payout.nullable().optional(),
  tags,
  notes: text(4_000),
  branchId: uuid.optional(),
};

const guarantorFields = {
  name: z.string().trim().min(1).max(120).optional(),
  phone: phone.optional(),
  relationship: text(60),
  address: text(300),
  occupation: text(80),
  ghanaCardNumber: text(20),
};

const customerFields = {
  firstName: text(80),
  lastName: text(80),
  companyName: text(160),
  phone: phone.nullable().optional(),
  altPhone: phone.nullable().optional(),
  email: text(254),
  address: text(300),
  dateOfBirth: date.nullable().optional(),
  occupation: text(80),
  ghanaCardNumber: text(20),
  licenceNumber: text(30),
  licenceClass: z.enum(LICENCE_CLASSES).nullable().optional(),
  licenceExpiresOn: date.nullable().optional(),
  registrationNumber: text(40),
  tin: text(20),
  contactPerson: text(120),
  creditLimit: amount.nullable().optional(),
  paymentTermsDays: z.number().int().min(0).max(365).nullable().optional(),
  source: z.enum(CUSTOMER_SOURCES).nullable().optional(),
  homeBranchId: uuid.nullable().optional(),
  tags,
  notes: text(4_000),
};

const supplierFields = {
  name: z.string().trim().min(1).max(160).optional(),
  type: z.enum(SUPPLIER_TYPES).optional(),
  contactPerson: text(120),
  phone: phone.nullable().optional(),
  email: text(254),
  address: text(300),
  tin: text(20),
  paymentTermsDays: z.number().int().min(0).max(365).nullable().optional(),
  payout: payout.nullable().optional(),
  active: z.boolean().optional(),
  tags,
  notes: text(4_000),
};

const documentFields = {
  number: text(60),
  issuedOn: date.nullable().optional(),
  expiresOn: date.nullable().optional(),
  notes: text(2_000),
};
const upload = z.object({
  filename: z.string().trim().min(1).max(200),
  contentType: z.string().trim().min(3).max(100),
  sizeBytes: z.number().int().min(1).max(FILE_KINDS.party_document.maxBytes),
});

export type PartyRouteDependencies = Readonly<{
  drivers: DriverAdministration;
  guarantors: DriverGuarantors;
  customers: CustomerAdministration;
  suppliers: SupplierAdministration;
  documents: PartyDocuments;
  driverSettings: DriverSettingsService;
}>;

/**
 * Document routes for one kind of party: list, add, correct, remove, attach scans. `base` is the
 * path to the party, `ref` builds the party reference from the path parameters.
 */
function documentRoutes(
  documents: PartyDocuments,
  tag: string,
  base: string,
  params: z.ZodObject,
  ref: (params: Record<string, string>) => PartyRef,
  view: PermissionKey,
  manage: PermissionKey,
): ApiRoute[] {
  const withDocument = params.extend({ documentId: uuid });
  const withFile = withDocument.extend({ fileId: uuid });
  return [
    defineRoute({
      method: "get",
      path: `${base}/documents`,
      summary: "Identity documents with their scans (sensitive)",
      tags: [tag],
      access: access.permission(view),
      request: { params },
      responses: { 200: { description: "Documents" } },
      handler: async ({ params: p }, _req, res) => {
        res.json(
          envelope(await documents.list(principalOf(res), ref(p as Record<string, string>))),
        );
      },
    }),
    defineRoute({
      method: "post",
      path: `${base}/documents`,
      summary: "Add an identity document",
      tags: [tag],
      access: access.permission(manage),
      request: {
        params,
        body: z.object({ type: z.enum(PARTY_DOCUMENT_TYPES), ...documentFields }),
      },
      responses: { 201: { description: "Document" } },
      handler: async ({ params: p, body }, _req, res) => {
        res
          .status(201)
          .json(
            envelope(await documents.add(principalOf(res), ref(p as Record<string, string>), body)),
          );
      },
    }),
    defineRoute({
      method: "patch",
      path: `${base}/documents/:documentId`,
      summary: "Correct an identity document",
      tags: [tag],
      access: access.permission(manage),
      request: {
        params: withDocument,
        body: z.object({ type: z.enum(PARTY_DOCUMENT_TYPES).optional(), ...documentFields }),
      },
      responses: { 200: { description: "Document" } },
      handler: async ({ params: p, body }, _req, res) => {
        const path = p as Record<string, string>;
        res.json(
          envelope(await documents.update(principalOf(res), ref(path), path.documentId!, body)),
        );
      },
    }),
    defineRoute({
      method: "delete",
      path: `${base}/documents/:documentId`,
      summary: "Remove an identity document with its scans",
      tags: [tag],
      access: access.permission(manage),
      request: { params: withDocument },
      responses: { 204: { description: "Removed" } },
      handler: async ({ params: p }, _req, res) => {
        const path = p as Record<string, string>;
        await documents.remove(principalOf(res), ref(path), path.documentId!);
        res.status(204).end();
      },
    }),
    defineRoute({
      method: "post",
      path: `${base}/documents/:documentId/files`,
      summary: "Attach a scan (pre-signed upload, then complete)",
      tags: [tag],
      access: access.permission(manage),
      request: { params: withDocument, body: upload },
      responses: { 201: { description: "Upload URL" } },
      handler: async ({ params: p, body }, _req, res) => {
        const path = p as Record<string, string>;
        res
          .status(201)
          .json(
            envelope(
              await documents.startFileUpload(principalOf(res), ref(path), path.documentId!, body),
            ),
          );
      },
    }),
    defineRoute({
      method: "post",
      path: `${base}/documents/:documentId/files/:fileId/complete`,
      summary: "Confirm a scan upload",
      tags: [tag],
      access: access.permission(manage),
      request: { params: withFile },
      responses: { 200: { description: "File" } },
      handler: async ({ params: p }, _req, res) => {
        const path = p as Record<string, string>;
        res.json(
          envelope(
            await documents.completeFileUpload(
              principalOf(res),
              ref(path),
              path.documentId!,
              path.fileId!,
            ),
          ),
        );
      },
    }),
    defineRoute({
      method: "delete",
      path: `${base}/documents/:documentId/files/:fileId`,
      summary: "Remove a scan",
      tags: [tag],
      access: access.permission(manage),
      request: { params: withFile },
      responses: { 204: { description: "Removed" } },
      handler: async ({ params: p }, _req, res) => {
        const path = p as Record<string, string>;
        await documents.removeFile(principalOf(res), ref(path), path.documentId!, path.fileId!);
        res.status(204).end();
      },
    }),
  ];
}

/**
 * Parties (docs/05 §2.2, docs/09 §4): drivers (branch-scoped) with guarantors, onboarding and
 * status; customers (shared by every branch) with KYC and risk status; suppliers; identity
 * documents of all of them; driver onboarding settings.
 */
export function partyRoutes(deps: PartyRouteDependencies): ApiRoute[] {
  const { drivers, guarantors, customers, suppliers, documents, driverSettings } = deps;
  const statusRoute = (action: DriverAction) =>
    defineRoute({
      method: "post",
      path: `/api/v1/drivers/:id/${action}`,
      summary: `${action[0]!.toUpperCase()}${action.slice(1)} a driver`,
      tags: ["drivers"],
      access: access.permission(DRIVER_ACTIONS[action].permission),
      request: {
        params: idParams,
        body: z.object({
          reason: action === "activate" ? reason.nullable().optional() : reason,
        }),
      },
      responses: { 200: { description: "Driver" }, 422: { description: "Not allowed" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(
          envelope(
            await drivers.changeStatus(principalOf(res), params.id, action, body.reason ?? null),
          ),
        );
      },
    });

  return [
    // --- driver settings ---
    defineRoute({
      method: "get",
      path: "/api/v1/settings/drivers",
      summary: "Driver onboarding requirements",
      tags: ["settings"],
      access: access.permission("settings.view"),
      responses: { 200: { description: "Rules" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await driverSettings.get()));
      },
    }),
    defineRoute({
      method: "patch",
      path: "/api/v1/settings/drivers",
      summary: "Change the driver onboarding requirements",
      tags: ["settings"],
      access: access.permission("settings.update"),
      request: {
        body: z.object({
          requireGhanaCard: z.boolean().optional(),
          requireValidLicence: z.boolean().optional(),
          requiredGuarantors: z.number().int().min(0).max(5).optional(),
          requiredDocuments: z.array(z.enum(PARTY_DOCUMENT_TYPES)).max(10).optional(),
        }),
      },
      responses: { 200: { description: "Rules" } },
      handler: async ({ body }, _req, res) => {
        res.json(envelope(await driverSettings.update(principalOf(res), body)));
      },
    }),

    // --- drivers (static paths first) ---
    defineRoute({
      method: "get",
      path: "/api/v1/drivers",
      summary: "Drivers in your branches",
      tags: ["drivers"],
      access: access.permission("drivers.list"),
      request: {
        query: z.object({
          status: z
            .string()
            .optional()
            .transform((v) => (v === undefined ? undefined : v.split(",").map((s) => s.trim())))
            .pipe(z.array(z.enum(DRIVER_STATUSES)).optional()),
          branchId: uuid.optional(),
          employmentType: z.enum(EMPLOYMENT_TYPES).optional(),
          search: z.string().trim().min(1).max(60).optional(),
          ...page,
        }),
      },
      responses: { 200: { description: "Drivers; `meta.nextCursor` for the next page" } },
      handler: async ({ query }, _req, res) => {
        const { status, ...rest } = query;
        const result = await drivers.list(principalOf(res), {
          ...rest,
          ...(status === undefined ? {} : { statuses: status }),
        });
        res.json(envelope(result.items, { nextCursor: result.nextCursor }));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/drivers",
      summary: "Register a driver (as an applicant)",
      tags: ["drivers"],
      access: access.permission("drivers.create"),
      request: {
        body: z.object({
          ...driverFields,
          firstName: z.string().trim().min(1).max(80),
          lastName: z.string().trim().min(1).max(80),
          phone,
        }),
      },
      responses: { 201: { description: "Driver" }, 409: { description: "Already registered" } },
      handler: async ({ body }, _req, res) => {
        res.status(201).json(envelope(await drivers.create(principalOf(res), body)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/drivers/expiring-licences",
      summary: "Drivers whose licence has expired or expires within `days`",
      tags: ["drivers"],
      access: access.permission("drivers.list"),
      request: {
        query: z.object({ days: z.coerce.number().int().min(0).max(365).default(30) }),
      },
      responses: { 200: { description: "Drivers, soonest expiry first" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await drivers.expiringLicences(principalOf(res), query.days)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/drivers/:id",
      summary: "A driver with guarantors and the onboarding checklist",
      tags: ["drivers"],
      access: access.permission("drivers.view"),
      request: { params: idParams },
      responses: { 200: { description: "Driver" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await drivers.get(principalOf(res), params.id)));
      },
    }),
    defineRoute({
      method: "patch",
      path: "/api/v1/drivers/:id",
      summary: "Edit a driver (or move them to another branch)",
      tags: ["drivers"],
      access: access.permission("drivers.update"),
      request: { params: idParams, body: z.object(driverFields) },
      responses: { 200: { description: "Driver" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await drivers.update(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "delete",
      path: "/api/v1/drivers/:id",
      summary: "Remove a mistaken entry (applicants and terminated drivers only)",
      tags: ["drivers"],
      access: access.permission("drivers.delete"),
      request: { params: idParams, body: z.object({ reason }) },
      responses: { 204: { description: "Removed" } },
      handler: async ({ params, body }, _req, res) => {
        await drivers.remove(principalOf(res), params.id, body.reason);
        res.status(204).end();
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/drivers/:id/onboarding",
      summary: "What is still needed before the driver can start",
      tags: ["drivers"],
      access: access.permission("drivers.view"),
      request: { params: idParams },
      responses: { 200: { description: "Checklist" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await drivers.onboarding(principalOf(res), params.id)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/drivers/:id/status-history",
      summary: "Status changes with their reasons",
      tags: ["drivers"],
      access: access.permission("drivers.view"),
      request: { params: idParams },
      responses: { 200: { description: "History, newest first" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await drivers.statusHistory(principalOf(res), params.id)));
      },
    }),
    ...(Object.keys(DRIVER_ACTIONS) as DriverAction[]).map(statusRoute),

    // --- guarantors ---
    defineRoute({
      method: "post",
      path: "/api/v1/drivers/:id/guarantors",
      summary: "Add a guarantor",
      tags: ["drivers"],
      access: access.permission("drivers.update"),
      request: {
        params: idParams,
        body: z.object({
          ...guarantorFields,
          name: z.string().trim().min(1).max(120),
          phone,
        }),
      },
      responses: { 201: { description: "Guarantor" } },
      handler: async ({ params, body }, _req, res) => {
        res.status(201).json(envelope(await guarantors.add(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "patch",
      path: "/api/v1/drivers/:id/guarantors/:guarantorId",
      summary: "Edit a guarantor",
      tags: ["drivers"],
      access: access.permission("drivers.update"),
      request: {
        params: z.object({ id: uuid, guarantorId: uuid }),
        body: z.object(guarantorFields),
      },
      responses: { 200: { description: "Guarantor" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(
          envelope(await guarantors.update(principalOf(res), params.id, params.guarantorId, body)),
        );
      },
    }),
    defineRoute({
      method: "delete",
      path: "/api/v1/drivers/:id/guarantors/:guarantorId",
      summary: "Remove a guarantor",
      tags: ["drivers"],
      access: access.permission("drivers.update"),
      request: { params: z.object({ id: uuid, guarantorId: uuid }) },
      responses: { 204: { description: "Removed" } },
      handler: async ({ params }, _req, res) => {
        await guarantors.remove(principalOf(res), params.id, params.guarantorId);
        res.status(204).end();
      },
    }),
    ...documentRoutes(
      documents,
      "drivers",
      "/api/v1/drivers/:id",
      idParams,
      (p) => ({ type: "driver", driverId: p.id! }),
      "drivers.documents.view",
      "drivers.update",
    ),
    ...documentRoutes(
      documents,
      "drivers",
      "/api/v1/drivers/:id/guarantors/:guarantorId",
      z.object({ id: uuid, guarantorId: uuid }),
      (p) => ({ type: "driver_guarantor", driverId: p.id!, guarantorId: p.guarantorId! }),
      "drivers.documents.view",
      "drivers.update",
    ),

    // --- customers ---
    defineRoute({
      method: "get",
      path: "/api/v1/customers",
      summary: "Customers (search by name, code, phone, email or Ghana Card)",
      tags: ["customers"],
      access: access.permission("customers.list"),
      request: {
        query: z.object({
          type: z.enum(CUSTOMER_TYPES).optional(),
          riskStatus: z.enum(RISK_STATUSES).optional(),
          search: z.string().trim().min(1).max(60).optional(),
          ...page,
        }),
      },
      responses: { 200: { description: "Customers; `meta.nextCursor` for the next page" } },
      handler: async ({ query }, _req, res) => {
        const result = await customers.list(principalOf(res), query);
        res.json(envelope(result.items, { nextCursor: result.nextCursor }));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/customers",
      summary: "Register a customer (individual or company)",
      tags: ["customers"],
      access: access.permission("customers.create"),
      request: { body: z.object({ ...customerFields, type: z.enum(CUSTOMER_TYPES) }) },
      responses: { 201: { description: "Customer" }, 409: { description: "Already registered" } },
      handler: async ({ body }, _req, res) => {
        res.status(201).json(envelope(await customers.create(principalOf(res), body)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/customers/:id",
      summary: "A customer",
      tags: ["customers"],
      access: access.permission("customers.view"),
      request: { params: idParams },
      responses: { 200: { description: "Customer" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await customers.get(principalOf(res), params.id)));
      },
    }),
    defineRoute({
      method: "patch",
      path: "/api/v1/customers/:id",
      summary: "Edit a customer",
      tags: ["customers"],
      access: access.permission("customers.update"),
      request: {
        params: idParams,
        body: z.object({ ...customerFields, type: z.enum(CUSTOMER_TYPES).optional() }),
      },
      responses: { 200: { description: "Customer" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await customers.update(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "delete",
      path: "/api/v1/customers/:id",
      summary: "Remove a mistaken entry",
      tags: ["customers"],
      access: access.permission("customers.delete"),
      request: { params: idParams, body: z.object({ reason }) },
      responses: { 204: { description: "Removed" } },
      handler: async ({ params, body }, _req, res) => {
        await customers.remove(principalOf(res), params.id, body.reason);
        res.status(204).end();
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/customers/:id/risk",
      summary: "Put a customer on watch, blacklist or clear them (with a reason)",
      tags: ["customers"],
      access: access.permission("customers.blacklist"),
      request: { params: idParams, body: z.object({ status: z.enum(RISK_STATUSES), reason }) },
      responses: { 200: { description: "Customer" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(
          envelope(await customers.setRisk(principalOf(res), params.id, body.status, body.reason)),
        );
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/customers/:id/risk-history",
      summary: "Risk status changes with their reasons",
      tags: ["customers"],
      access: access.permission("customers.view"),
      request: { params: idParams },
      responses: { 200: { description: "History, newest first" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await customers.riskHistory(params.id)));
      },
    }),
    ...documentRoutes(
      documents,
      "customers",
      "/api/v1/customers/:id",
      idParams,
      (p) => ({ type: "customer", customerId: p.id! }),
      "customers.id_documents.view",
      "customers.update",
    ),

    // --- suppliers ---
    defineRoute({
      method: "get",
      path: "/api/v1/suppliers",
      summary: "Suppliers by name",
      tags: ["suppliers"],
      access: access.permission("suppliers.list"),
      request: {
        query: z.object({
          type: z.enum(SUPPLIER_TYPES).optional(),
          includeInactive: z
            .enum(["true", "false"])
            .optional()
            .transform((v) => v === "true"),
          search: z.string().trim().min(1).max(60).optional(),
        }),
      },
      responses: { 200: { description: "Suppliers" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await suppliers.list(query)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/suppliers",
      summary: "Add a supplier",
      tags: ["suppliers"],
      access: access.permission("suppliers.create"),
      request: {
        body: z.object({
          ...supplierFields,
          name: z.string().trim().min(1).max(160),
          type: z.enum(SUPPLIER_TYPES),
        }),
      },
      responses: { 201: { description: "Supplier" }, 409: { description: "Name taken" } },
      handler: async ({ body }, _req, res) => {
        res.status(201).json(envelope(await suppliers.create(principalOf(res), body)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/suppliers/:id",
      summary: "A supplier",
      tags: ["suppliers"],
      access: access.permission("suppliers.view"),
      request: { params: idParams },
      responses: { 200: { description: "Supplier" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await suppliers.get(params.id)));
      },
    }),
    defineRoute({
      method: "patch",
      path: "/api/v1/suppliers/:id",
      summary: "Edit or deactivate a supplier",
      tags: ["suppliers"],
      access: access.permission("suppliers.update"),
      request: { params: idParams, body: z.object(supplierFields) },
      responses: { 200: { description: "Supplier" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await suppliers.update(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "delete",
      path: "/api/v1/suppliers/:id",
      summary: "Remove a mistaken entry",
      tags: ["suppliers"],
      access: access.permission("suppliers.delete"),
      request: { params: idParams, body: z.object({ reason }) },
      responses: { 204: { description: "Removed" } },
      handler: async ({ params, body }, _req, res) => {
        await suppliers.remove(principalOf(res), params.id, body.reason);
        res.status(204).end();
      },
    }),
  ];
}
