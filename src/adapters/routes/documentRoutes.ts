import { z } from "zod";
import type { HandoverDocuments } from "../../application/use-cases/assignments/HandoverDocuments.js";
import type { DocumentTemplates } from "../../application/use-cases/documents/DocumentTemplates.js";
import type { Documents } from "../../application/use-cases/documents/Documents.js";
import { DOCUMENT_TYPES, LANGUAGES } from "../../domain/documents/DocumentTypes.js";
import { principalOf } from "../middleware/AccessGuard.js";
import { sendPdf } from "../presenters/pdfResponse.js";
import { envelope } from "../presenters/responseEnvelope.js";
import { defineRoute, type ApiRoute } from "./ApiRoute.js";
import { access } from "./RouteAccess.js";

const uuid = z.uuid();
const idParams = z.object({ id: uuid });
const body = z.string().min(1).max(200_000);
const type = z.enum(DOCUMENT_TYPES);
const language = z.enum(LANGUAGES);

export type DocumentRouteDependencies = Readonly<{
  documents: Documents;
  templates: DocumentTemplates;
  handovers: HandoverDocuments;
}>;

/** The document engine (docs/24): templates, issued documents, PDFs and public verification. */
export function documentRoutes(deps: DocumentRouteDependencies): ApiRoute[] {
  const { documents, templates, handovers } = deps;
  return [
    // --- templates ---
    defineRoute({
      method: "get",
      path: "/api/v1/document-types",
      summary:
        "Document types with their fields, system template, locked clauses and version in use",
      tags: ["documents"],
      access: access.permission("documents.templates.view"),
      responses: { 200: { description: "Types" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await templates.catalog()));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/document-types/:type/use-system",
      summary: "Go back to the system template for a type",
      tags: ["documents"],
      access: access.permission("documents.templates.manage"),
      request: {
        params: z.object({ type }),
        body: z.object({ language: language.default("en") }),
      },
      responses: { 204: { description: "Done" } },
      handler: async ({ params, body: input }, _req, res) => {
        await templates.useSystem(principalOf(res), params.type, input.language);
        res.status(204).end();
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/document-templates",
      summary: "The business's template versions, newest first",
      tags: ["documents"],
      access: access.permission("documents.templates.view"),
      request: { query: z.object({ type: type.optional(), language: language.optional() }) },
      responses: { 200: { description: "Templates" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await templates.list(query)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/document-templates/preview",
      summary: "A PDF of a template filled with sample data (the system one without a body)",
      tags: ["documents"],
      access: access.permission("documents.templates.view"),
      request: { body: z.object({ type, body: body.nullable().optional() }) },
      responses: { 200: { description: "application/pdf" } },
      handler: async ({ body: input }, _req, res) => {
        sendPdf(res, {
          filename: `${input.type}-preview.pdf`,
          content: await templates.preview(input.type, input.body ?? null),
        });
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/document-templates",
      summary: "Start a new template version (a draft, checked against the locked clauses)",
      tags: ["documents"],
      access: access.permission("documents.templates.manage"),
      request: {
        body: z.object({ type, language: language.optional(), name: z.string().max(120), body }),
      },
      responses: { 201: { description: "Draft" } },
      handler: async ({ body: input }, _req, res) => {
        res.status(201).json(envelope(await templates.create(principalOf(res), input)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/document-templates/:id",
      summary: "A template version",
      tags: ["documents"],
      access: access.permission("documents.templates.view"),
      request: { params: idParams },
      responses: { 200: { description: "Template" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await templates.get(params.id)));
      },
    }),
    defineRoute({
      method: "put",
      path: "/api/v1/document-templates/:id",
      summary: "Edit a draft",
      tags: ["documents"],
      access: access.permission("documents.templates.manage"),
      request: {
        params: idParams,
        body: z.object({ name: z.string().max(120).optional(), body: body.optional() }),
      },
      responses: { 200: { description: "Draft" } },
      handler: async ({ params, body: input }, _req, res) => {
        res.json(envelope(await templates.update(principalOf(res), params.id, input)));
      },
    }),
    defineRoute({
      method: "delete",
      path: "/api/v1/document-templates/:id",
      summary: "Delete a draft",
      tags: ["documents"],
      access: access.permission("documents.templates.manage"),
      request: { params: idParams },
      responses: { 204: { description: "Deleted" } },
      handler: async ({ params }, _req, res) => {
        await templates.remove(principalOf(res), params.id);
        res.status(204).end();
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/document-templates/:id/activate",
      summary: "Put a draft in use for new documents (the previous version is archived)",
      tags: ["documents"],
      access: access.permission("documents.templates.manage"),
      request: { params: idParams },
      responses: { 200: { description: "Template" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await templates.activate(principalOf(res), params.id)));
      },
    }),

    // --- issued documents ---
    defineRoute({
      method: "post",
      path: "/api/v1/assignments/:id/handover-document",
      summary: "Issue the handover document of an assignment (or a correction of it)",
      tags: ["documents"],
      access: access.permission("documents.issue"),
      request: {
        params: idParams,
        body: z.object({
          replacesId: uuid.nullable().optional(),
          /** False: printed and signed by hand. */
          signInSystem: z.boolean().optional(),
          /** Who signs for the business (default: you). */
          businessSignerId: uuid.nullable().optional(),
        }),
      },
      responses: { 201: { description: "Document (its PDF follows shortly)" } },
      handler: async ({ params, body: input }, _req, res) => {
        res.status(201).json(envelope(await handovers.issue(principalOf(res), params.id, input)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/documents",
      summary: "Issued documents in your branches, newest first",
      tags: ["documents"],
      access: access.permission("documents.list"),
      request: {
        query: z.object({
          type: type.optional(),
          subjectType: z.string().max(60).optional(),
          subjectId: uuid.optional(),
          status: z.enum(["issued", "void"]).optional(),
          branchId: uuid.optional(),
          cursor: z.string().max(300).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(30),
        }),
      },
      responses: { 200: { description: "Documents; `meta.nextCursor` for the next page" } },
      handler: async ({ query }, _req, res) => {
        const { subjectType, subjectId, ...rest } = query;
        const page = await documents.list(principalOf(res), {
          ...rest,
          ...(subjectType !== undefined && subjectId !== undefined
            ? { subject: { type: subjectType, id: subjectId } }
            : {}),
        });
        res.json(envelope(page.items, { nextCursor: page.nextCursor }));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/documents/:id",
      summary: "A document with its data snapshot and history",
      tags: ["documents"],
      access: access.permission("documents.view"),
      request: { params: idParams },
      responses: { 200: { description: "Document" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await documents.get(principalOf(res), params.id)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/documents/:id/download",
      summary: "A short-lived link to the document's PDF (or its signed copy), with its SHA-256",
      tags: ["documents"],
      access: access.permission("documents.view"),
      request: {
        params: idParams,
        query: z.object({ copy: z.enum(["issued", "signed"]).default("issued") }),
      },
      responses: { 200: { description: "File link" } },
      handler: async ({ params, query }, _req, res) => {
        res.json(envelope(await documents.download(principalOf(res), params.id, query.copy)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/documents/:id/void",
      summary: "Void a document (it stays on record; verification shows it void)",
      tags: ["documents"],
      access: access.permission("documents.void"),
      request: { params: idParams, body: z.object({ reason: z.string().trim().min(3).max(500) }) },
      responses: { 200: { description: "Document" } },
      handler: async ({ params, body: input }, _req, res) => {
        res.json(envelope(await documents.void(principalOf(res), params.id, input.reason)));
      },
    }),

    // --- public verification (X-Tenant) ---
    defineRoute({
      method: "get",
      path: "/api/v1/public/documents/:code",
      summary: "Check a document by its verification code (and optionally a copy's SHA-256)",
      tags: ["documents"],
      access: access.tenant(),
      request: {
        params: z.object({ code: z.string().min(8).max(20) }),
        query: z.object({
          sha256: z
            .string()
            .regex(/^[0-9a-fA-F]{64}$/)
            .optional(),
        }),
      },
      responses: { 200: { description: "What the document is and whether it is valid" } },
      handler: async ({ params, query }, _req, res) => {
        res.json(envelope(await documents.verify(params.code, query.sha256 ?? null)));
      },
    }),
  ];
}
