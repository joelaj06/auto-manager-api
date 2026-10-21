import { z } from "zod";
import type { DocumentSettingsService } from "../../application/use-cases/documents/DocumentSettingsService.js";
import type {
  DocumentSigning,
  SignatureInput,
  SignerAccess,
} from "../../application/use-cases/documents/DocumentSigning.js";
import { FILE_KINDS } from "../../domain/files/FileKinds.js";
import { principalOf } from "../middleware/AccessGuard.js";
import { envelope } from "../presenters/responseEnvelope.js";
import { defineRoute, type ApiRoute } from "./ApiRoute.js";
import { access } from "./RouteAccess.js";

const uuid = z.uuid();
const signerParams = z.object({ signerId: uuid });
const docSignerParams = z.object({ id: uuid, signerId: uuid });
const token = z.string().min(20).max(200);
const reason = z.string().trim().min(3).max(500);
const signature = z.object({
  code: z.string().trim().max(10).optional(),
  signature: z.discriminatedUnion("type", [
    z.object({ type: z.literal("drawn"), png: z.string().min(100).max(800_000) }),
    z.object({ type: z.literal("typed"), name: z.string().trim().min(2).max(160) }),
  ]),
  consent: z.boolean(),
});

const input = (
  body: z.output<typeof signature>,
  userAgent: string | undefined,
): SignatureInput => ({
  signature: body.signature,
  consent: body.consent,
  userAgent: userAgent ?? null,
  ...(body.code === undefined ? {} : { code: body.code }),
});

export type SigningRouteDependencies = Readonly<{
  signing: DocumentSigning;
  settings: DocumentSettingsService;
}>;

/**
 * Signing documents (docs/24 §4, §8): the caller's own signatures (staff and drivers, signed in),
 * guests with a single-use link (the token travels in the body, never in a URL), and the staff
 * tools — new link with QR, reminders, paper signatures — and settings.
 */
export function signingRoutes(deps: SigningRouteDependencies): ApiRoute[] {
  const { signing, settings } = deps;
  const me = (res: Parameters<typeof principalOf>[0]): SignerAccess => ({
    kind: "account",
    actor: principalOf(res),
  });
  return [
    // --- my signatures ---
    defineRoute({
      method: "get",
      path: "/api/v1/me/signatures",
      summary: "Documents waiting for my signature",
      tags: ["signatures"],
      access: access.signedIn(),
      responses: { 200: { description: "Signing tasks" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await signing.mine(principalOf(res))));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/me/signatures/:signerId",
      summary: "One signature to give, with the PDF to read first",
      tags: ["signatures"],
      access: access.signedIn(),
      request: { params: signerParams },
      responses: { 200: { description: "Signing task" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await signing.open(me(res), params.signerId)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/me/signatures/:signerId/code",
      summary: "Send me the code that confirms my signature",
      tags: ["signatures"],
      access: access.signedIn(),
      request: { params: signerParams },
      responses: { 200: { description: "Where the code went" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await signing.sendCode(me(res), params.signerId)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/me/signatures/:signerId/sign",
      summary: "Sign: the code, a drawn (PNG) or typed signature, and consent",
      tags: ["signatures"],
      access: access.signedIn(),
      request: { params: signerParams, body: signature },
      responses: { 200: { description: "Signing task" } },
      handler: async ({ params, body }, req, res) => {
        res.json(
          envelope(
            await signing.sign(me(res), params.signerId, input(body, req.get("user-agent"))),
          ),
        );
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/me/signatures/:signerId/decline",
      summary: "Decline to sign, with a reason",
      tags: ["signatures"],
      access: access.signedIn(),
      request: { params: signerParams, body: z.object({ reason }) },
      responses: { 200: { description: "Signing task" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await signing.decline(me(res), params.signerId, body.reason)));
      },
    }),

    // --- guests (X-Tenant; the token from the link) ---
    defineRoute({
      method: "post",
      path: "/api/v1/public/signing/open",
      summary: "The document a signing link is for, with the PDF to read",
      tags: ["signatures"],
      access: access.tenant(),
      request: { body: z.object({ token }) },
      responses: { 200: { description: "Signing task" } },
      handler: async ({ body }, _req, res) => {
        res.json(envelope(await signing.open({ kind: "link", token: body.token }, null)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/public/signing/code",
      summary: "Send the signer's code",
      tags: ["signatures"],
      access: access.tenant(),
      request: { body: z.object({ token }) },
      responses: { 200: { description: "Where the code went" } },
      handler: async ({ body }, _req, res) => {
        res.json(envelope(await signing.sendCode({ kind: "link", token: body.token }, null)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/public/signing/sign",
      summary: "Sign with a signing link (the link then stops working)",
      tags: ["signatures"],
      access: access.tenant(),
      request: { body: signature.extend({ token }) },
      responses: { 200: { description: "Signing task" } },
      handler: async ({ body }, req, res) => {
        res.json(
          envelope(
            await signing.sign(
              { kind: "link", token: body.token },
              null,
              input(body, req.get("user-agent")),
            ),
          ),
        );
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/public/signing/decline",
      summary: "Decline with a signing link",
      tags: ["signatures"],
      access: access.tenant(),
      request: { body: z.object({ token, reason }) },
      responses: { 200: { description: "Signing task" } },
      handler: async ({ body }, _req, res) => {
        res.json(
          envelope(await signing.decline({ kind: "link", token: body.token }, null, body.reason)),
        );
      },
    }),

    // --- staff ---
    defineRoute({
      method: "post",
      path: "/api/v1/documents/:id/signers/:signerId/link",
      summary: "A new signing link (and QR) for a guest signer; earlier links stop working",
      tags: ["signatures"],
      access: access.permission("documents.issue"),
      request: { params: docSignerParams },
      responses: { 200: { description: "Link" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await signing.newLink(principalOf(res), params.id, params.signerId)));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/documents/:id/remind",
      summary: "Remind everyone who has not signed yet",
      tags: ["signatures"],
      access: access.permission("documents.issue"),
      request: { params: z.object({ id: uuid }) },
      responses: { 200: { description: "How many were reminded" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope({ reminded: await signing.remind(principalOf(res), params.id) }));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/documents/:id/signers/:signerId/paper-scans",
      summary: "Upload the scan of a signature made on paper",
      tags: ["signatures"],
      access: access.permission("documents.attach_paper"),
      request: {
        params: docSignerParams,
        body: z.object({
          filename: z.string().trim().min(1).max(200),
          contentType: z.string().trim().min(3).max(100),
          sizeBytes: z.number().int().min(1).max(FILE_KINDS.signed_paper_scan.maxBytes),
        }),
      },
      responses: { 201: { description: "Upload URL" } },
      handler: async ({ params, body }, _req, res) => {
        res
          .status(201)
          .json(
            envelope(
              await signing.startPaperScan(principalOf(res), params.id, params.signerId, body),
            ),
          );
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/documents/:id/signers/:signerId/paper-scans/:fileId/complete",
      summary: "Confirm the scan: the signer counts as signed on paper (checked by you)",
      tags: ["signatures"],
      access: access.permission("documents.attach_paper"),
      request: { params: docSignerParams.extend({ fileId: uuid }) },
      responses: { 200: { description: "Signer" } },
      handler: async ({ params }, _req, res) => {
        res.json(
          envelope(
            await signing.completePaperScan(
              principalOf(res),
              params.id,
              params.signerId,
              params.fileId,
            ),
          ),
        );
      },
    }),

    // --- settings ---
    defineRoute({
      method: "get",
      path: "/api/v1/settings/documents",
      summary: "Signing settings (codes, deadline, reminders, links, typed signatures)",
      tags: ["settings"],
      access: access.permission("settings.view"),
      responses: { 200: { description: "Settings" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await settings.get()));
      },
    }),
    defineRoute({
      method: "patch",
      path: "/api/v1/settings/documents",
      summary: "Change the signing settings",
      tags: ["settings"],
      access: access.permission("documents.templates.manage"),
      request: {
        body: z.object({
          requireOtp: z.boolean().optional(),
          signingDays: z.number().int().optional(),
          reminderEveryDays: z.number().int().optional(),
          maxReminders: z.number().int().optional(),
          linkHours: z.number().int().optional(),
          allowTypedSignature: z.boolean().optional(),
        }),
      },
      responses: { 200: { description: "Settings" } },
      handler: async ({ body }, _req, res) => {
        res.json(envelope(await settings.update(principalOf(res), body)));
      },
    }),
  ];
}
