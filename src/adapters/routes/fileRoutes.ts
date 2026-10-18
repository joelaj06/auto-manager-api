import { z } from "zod";
import type { ApplicationDocuments } from "../../application/use-cases/applications/ApplicationDocuments.js";
import type { FileView, UploadStarted } from "../../application/use-cases/files/FileService.js";
import type { TenantFileUploads } from "../../application/use-cases/files/TenantFileUploads.js";
import type { OrganisationAdministration } from "../../application/use-cases/identity/OrganisationAdministration.js";
import type { PartnerDocuments } from "../../application/use-cases/partners/PartnerDocuments.js";
import { FILE_KINDS, type FileKind } from "../../domain/files/FileKinds.js";
import { principalOf, staffOf } from "../middleware/AccessGuard.js";
import { envelope } from "../presenters/responseEnvelope.js";
import { defineRoute, type ApiRoute } from "./ApiRoute.js";
import { tokenOf } from "./applicationRoutes.js";
import { access } from "./RouteAccess.js";

const CONSOLE = "/api/platform/v1";
const uuid = z.uuid();
const MAX_BYTES = Math.max(...Object.values(FILE_KINDS).map((k) => k.maxBytes));
const TENANT_KINDS = (Object.keys(FILE_KINDS) as FileKind[]).filter(
  (kind) => FILE_KINDS[kind].scope === "tenant",
);

const document = z.object({
  filename: z.string().trim().min(1).max(200),
  contentType: z.string().trim().min(3).max(100),
  sizeBytes: z.number().int().min(1).max(MAX_BYTES),
});
const reason = z.string().trim().min(5).max(1_000);

const started = (result: UploadStarted) => envelope(result);
const file = (view: FileView) => envelope(view);

const UPLOAD_HELP =
  "Send the bytes with `upload.method` to `upload.url` with exactly `upload.headers` (and the " +
  "announced size), then call complete. The URL expires at `upload.expiresAt`.";

export type FileRouteDependencies = Readonly<{
  tenantFiles: TenantFileUploads;
  organisation: OrganisationAdministration;
  applicationDocuments: ApplicationDocuments;
  partnerDocuments: PartnerDocuments;
}>;

/**
 * Files (docs/03 §12): uploads go straight to object storage with pre-signed URLs and are
 * confirmed afterwards (size and real type checked). Tenant files, applicants' KYC documents and
 * partner documents.
 */
export function fileRoutes(deps: FileRouteDependencies): ApiRoute[] {
  const { tenantFiles, organisation, applicationDocuments, partnerDocuments } = deps;
  const applicationParams = z.object({ id: uuid });
  const applicationFileParams = z.object({ id: uuid, fileId: uuid });

  return [
    // --- tenant ---
    defineRoute({
      method: "post",
      path: "/api/v1/files/uploads",
      summary: "Start an upload (returns a pre-signed URL)",
      tags: ["files"],
      access: access.signedIn(),
      request: {
        body: document.extend({
          kind: z.enum(TENANT_KINDS as [FileKind, ...FileKind[]]),
        }),
      },
      responses: { 201: { description: UPLOAD_HELP } },
      handler: async ({ body }, _req, res) => {
        res.status(201).json(started(await tenantFiles.start(principalOf(res), body)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/files/:id/complete",
      summary: "Confirm an upload (checks size and real file type)",
      tags: ["files"],
      access: access.signedIn(),
      request: { params: z.object({ id: uuid }) },
      responses: {
        200: { description: "The file, now ready" },
        400: { description: "Not the announced file (deleted)" },
      },
      handler: async ({ params }, _req, res) => {
        res.json(file(await tenantFiles.complete(principalOf(res), params.id)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/files/:id",
      summary: "A file with its URL (signed and short-lived for private files)",
      tags: ["files"],
      access: access.signedIn(),
      request: { params: z.object({ id: uuid }) },
      responses: { 200: { description: "File" } },
      handler: async ({ params }, _req, res) => {
        res.json(file(await tenantFiles.get(principalOf(res), params.id)));
      },
    }),
    defineRoute({
      method: "put",
      path: "/api/v1/organisation/logo",
      summary: "Set the business logo to an uploaded logo file (null removes it)",
      tags: ["organisation"],
      access: access.permission("organisation.update"),
      request: { body: z.object({ fileId: uuid.nullable() }) },
      responses: { 200: { description: "Organisation" } },
      handler: async ({ body }, _req, res) => {
        res.json(envelope(await organisation.setLogo(principalOf(res), body.fileId)));
      },
    }),

    // --- applicant (private link) ---
    defineRoute({
      method: "post",
      path: "/api/v1/applications/:id/documents",
      summary: "Attach a KYC document to your application (X-Application-Token)",
      tags: ["applications"],
      access: access.public(),
      request: { params: applicationParams, body: document },
      responses: { 201: { description: UPLOAD_HELP } },
      handler: async ({ params, body }, req, res) => {
        res
          .status(201)
          .json(started(await applicationDocuments.start(params.id, tokenOf(req), body)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/applications/:id/documents/:fileId/complete",
      summary: "Confirm a document upload",
      tags: ["applications"],
      access: access.public(),
      request: { params: applicationFileParams },
      responses: { 200: { description: "The document" } },
      handler: async ({ params }, req, res) => {
        res.json(file(await applicationDocuments.complete(params.id, tokenOf(req), params.fileId)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/applications/:id/documents",
      summary: "Documents attached to your application",
      tags: ["applications"],
      access: access.public(),
      request: { params: applicationParams },
      responses: { 200: { description: "Documents with short-lived download links" } },
      handler: async ({ params }, req, res) => {
        res.json(envelope(await applicationDocuments.list(params.id, tokenOf(req))));
      },
    }),
    defineRoute({
      method: "delete",
      path: "/api/v1/applications/:id/documents/:fileId",
      summary: "Remove a document while the application is open",
      tags: ["applications"],
      access: access.public(),
      request: { params: applicationFileParams },
      responses: { 204: { description: "Removed" } },
      handler: async ({ params }, req, res) => {
        await applicationDocuments.remove(params.id, tokenOf(req), params.fileId);
        res.status(204).end();
      },
    }),

    // --- console ---
    defineRoute({
      method: "get",
      path: `${CONSOLE}/applications/:id/documents`,
      summary: "KYC documents of an application (short-lived download links)",
      tags: ["console: applications"],
      access: access.platform("platform.applications.view"),
      request: { params: applicationParams },
      responses: { 200: { description: "Documents" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await applicationDocuments.forReview(params.id)));
      },
    }),
    defineRoute({
      method: "post",
      path: `${CONSOLE}/partners/:id/documents`,
      summary: "Attach a document to a partner (KYC, signed agreement)",
      tags: ["console: partners"],
      access: access.platform("platform.partners.manage"),
      request: { params: applicationParams, body: document },
      responses: { 201: { description: UPLOAD_HELP } },
      handler: async ({ params, body }, _req, res) => {
        res.status(201).json(started(await partnerDocuments.start(params.id, body, staffOf(res))));
      },
    }),
    defineRoute({
      method: "post",
      path: `${CONSOLE}/partners/:id/documents/:fileId/complete`,
      summary: "Confirm a partner document upload",
      tags: ["console: partners"],
      access: access.platform("platform.partners.manage"),
      request: { params: applicationFileParams },
      responses: { 200: { description: "The document" } },
      handler: async ({ params }, _req, res) => {
        res.json(file(await partnerDocuments.complete(params.id, params.fileId, staffOf(res))));
      },
    }),
    defineRoute({
      method: "get",
      path: `${CONSOLE}/partners/:id/documents`,
      summary: "A partner's documents (short-lived download links)",
      tags: ["console: partners"],
      access: access.platform("platform.partners.view"),
      request: { params: applicationParams },
      responses: { 200: { description: "Documents" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await partnerDocuments.list(params.id)));
      },
    }),
    defineRoute({
      method: "delete",
      path: `${CONSOLE}/partners/:id/documents/:fileId`,
      summary: "Remove a partner document",
      tags: ["console: partners"],
      access: access.platform("platform.partners.manage"),
      request: { params: applicationFileParams, body: z.object({ reason }) },
      responses: { 204: { description: "Removed" } },
      handler: async ({ params, body }, _req, res) => {
        await partnerDocuments.remove(params.id, params.fileId, staffOf(res), body.reason);
        res.status(204).end();
      },
    }),
  ];
}
