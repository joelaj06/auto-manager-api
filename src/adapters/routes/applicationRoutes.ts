import type { Request } from "express";
import { z } from "zod";
import { ApplicationNotFoundError } from "../../application/errors/ApplicationErrors.js";
import type { ApplicationReview } from "../../application/use-cases/applications/ApplicationReview.js";
import type {
  ApplicantView,
  ApplicationSignup,
} from "../../application/use-cases/applications/ApplicationSignup.js";
import { staffOf } from "../middleware/AccessGuard.js";
import { envelope } from "../presenters/responseEnvelope.js";
import { defineRoute, type ApiRoute } from "./ApiRoute.js";
import { access } from "./RouteAccess.js";

/** The applicant's private-link token travels in this header, never in the URL. */
export const APPLICATION_TOKEN_HEADER = "x-application-token";

const PUBLIC = "/api/v1/applications";
const CONSOLE = "/api/platform/v1/applications";
const publicTags = ["signup"];
const consoleTags = ["console: applications"];

const uuid = z.uuid();
const idParams = z.object({ id: uuid });
const channel = z.enum(["email", "phone"]);
const optionalText = (max: number) => z.string().trim().max(max).nullish();

const signupBody = z.object({
  businessName: z.string().trim().min(2).max(120),
  businessType: z.enum(["fleet", "rental", "dealer", "mixed"]),
  country: z
    .string()
    .regex(/^[A-Za-z]{2}$/)
    .default("GH"),
  desiredSlug: z.string().trim().min(3).max(40),
  contactName: z.string().trim().min(2).max(120),
  contactEmail: z.email().max(320),
  contactPhone: z.string().trim().min(6).max(30),
  tin: optionalText(40),
  registrationNumber: optionalText(60),
  expectedBranches: z.number().int().min(1).max(1_000),
  expectedVehicles: z.number().int().min(0).max(100_000),
  heardAbout: optionalText(200),
  referralCode: optionalText(40),
  acceptTerms: z.literal(true, { error: "You must accept the terms to apply" }),
});

const tokenOf = (req: Request): string => {
  const token = req.get(APPLICATION_TOKEN_HEADER);
  if (token === undefined || !/^[A-Za-z0-9_-]{20,100}$/.test(token))
    throw new ApplicationNotFoundError();
  return token;
};

const applicantView = (view: ApplicantView) =>
  envelope({ ...view, messages: view.messages.map((m) => ({ ...m, at: m.at.toISOString() })) });

const context = (req: Request) => ({
  ip: req.ip ?? null,
  userAgent: req.get("user-agent")?.slice(0, 512) ?? null,
});

export type ApplicationRouteDependencies = Readonly<{
  signup: ApplicationSignup;
  review: ApplicationReview;
}>;

/** Public signup (`/api/v1/applications`) and the console review queue. */
export function applicationRoutes({ signup, review }: ApplicationRouteDependencies): ApiRoute[] {
  return [
    // --- public signup ---
    defineRoute({
      method: "get",
      path: `${PUBLIC}/slug-availability`,
      summary: "Is this business address name free?",
      tags: publicTags,
      access: access.public(),
      request: { query: z.object({ slug: z.string().min(1).max(60) }) },
      responses: { 200: { description: "{ available }" } },
      handler: async ({ query }, _req, res) => {
        res.json(
          envelope({
            slug: query.slug.trim().toLowerCase(),
            available: await signup.slugAvailable(query.slug),
          }),
        );
      },
    }),
    defineRoute({
      method: "post",
      path: PUBLIC,
      summary: "Apply for an account (sends email and phone verification codes)",
      tags: publicTags,
      access: access.public(),
      request: { body: signupBody },
      responses: {
        201: { description: "Application id and the private access token (keep it secret)" },
      },
      handler: async ({ body }, req, res) => {
        const { acceptTerms: _accepted, ...input } = body;
        const result = await signup.submit(input, context(req));
        res.status(201).json(envelope(result));
      },
    }),
    defineRoute({
      method: "get",
      path: `${PUBLIC}/:id`,
      summary: "Application status and messages (applicant)",
      tags: publicTags,
      access: access.public(),
      request: { params: idParams },
      responses: { 200: { description: "Status, verification state, messages" } },
      handler: async ({ params }, req, res) => {
        res.json(applicantView(await signup.view(params.id, tokenOf(req))));
      },
    }),
    defineRoute({
      method: "post",
      path: `${PUBLIC}/:id/verify`,
      summary: "Verify the email or phone code",
      tags: publicTags,
      access: access.public(),
      request: { params: idParams, body: z.object({ channel, code: z.string().regex(/^\d{6}$/) }) },
      responses: { 200: { description: "Updated application" } },
      handler: async ({ params, body }, req, res) => {
        res.json(
          applicantView(await signup.verify(params.id, tokenOf(req), body.channel, body.code)),
        );
      },
    }),
    defineRoute({
      method: "post",
      path: `${PUBLIC}/:id/resend-code`,
      summary: "Send a new email or phone code",
      tags: publicTags,
      access: access.public(),
      request: { params: idParams, body: z.object({ channel }) },
      responses: { 204: { description: "Sent" } },
      handler: async ({ params, body }, req, res) => {
        await signup.resendCode(params.id, tokenOf(req), body.channel);
        res.status(204).end();
      },
    }),
    defineRoute({
      method: "post",
      path: `${PUBLIC}/:id/reply`,
      summary: "Answer an information request (and correct details)",
      tags: publicTags,
      access: access.public(),
      request: {
        params: idParams,
        body: z.object({
          message: z.string().trim().min(5).max(2_000),
          corrections: z
            .object({
              businessName: z.string().trim().min(2).max(120).optional(),
              tin: z.string().trim().max(40).optional(),
              registrationNumber: z.string().trim().max(60).optional(),
              expectedBranches: z.number().int().min(1).max(1_000).optional(),
              expectedVehicles: z.number().int().min(0).max(100_000).optional(),
            })
            .default({}),
        }),
      },
      responses: { 200: { description: "Updated application" } },
      handler: async ({ params, body }, req, res) => {
        res.json(
          applicantView(
            await signup.reply(params.id, tokenOf(req), body.message, body.corrections),
          ),
        );
      },
    }),

    // --- console review queue ---
    defineRoute({
      method: "get",
      path: CONSOLE,
      summary: "Applications (newest first)",
      tags: consoleTags,
      access: access.platform("platform.applications.view"),
      request: {
        query: z.object({
          status: z
            .enum(["pending_verification", "pending_review", "needs_info", "approved", "rejected"])
            .optional(),
          search: z.string().trim().max(100).optional(),
          assignedTo: uuid.optional(),
          before: uuid.optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
      },
      responses: { 200: { description: "Application summaries" } },
      handler: async ({ query }, _req, res) => {
        const items = await review.list(query);
        res.json(
          envelope(items, {
            nextBefore: items.length === query.limit ? (items.at(-1)?.id ?? null) : null,
          }),
        );
      },
    }),
    defineRoute({
      method: "post",
      path: CONSOLE,
      summary: "Assisted signup: apply on behalf of a client (they verify email and phone)",
      tags: consoleTags,
      access: access.platform("platform.applications.create_assisted"),
      request: { body: signupBody },
      responses: { 201: { description: "Created; the client receives the private link by email" } },
      handler: async ({ body }, req, res) => {
        const { acceptTerms: _accepted, ...input } = body;
        const result = await signup.submit(input, {
          ...context(req),
          staffId: staffOf(res).userId,
        });
        res.status(201).json(envelope(result));
      },
    }),
    defineRoute({
      method: "get",
      path: `${CONSOLE}/:id`,
      summary: "Application with risk signals, timeline and similar applications",
      tags: consoleTags,
      access: access.platform("platform.applications.view"),
      request: { params: idParams },
      responses: { 200: { description: "Application" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await review.get(params.id)));
      },
    }),
    defineRoute({
      method: "post",
      path: `${CONSOLE}/:id/assign`,
      summary: "Assign a reviewer (null to unassign)",
      tags: consoleTags,
      access: access.platform("platform.applications.review"),
      request: { params: idParams, body: z.object({ assigneeId: uuid.nullable() }) },
      responses: { 204: { description: "Assigned" } },
      handler: async ({ params, body }, _req, res) => {
        await review.assign(params.id, body.assigneeId, staffOf(res));
        res.status(204).end();
      },
    }),
    defineRoute({
      method: "post",
      path: `${CONSOLE}/:id/request-info`,
      summary: "Ask the applicant for more information (emails them)",
      tags: consoleTags,
      access: access.platform("platform.applications.review"),
      request: {
        params: idParams,
        body: z.object({ message: z.string().trim().min(5).max(2_000) }),
      },
      responses: { 204: { description: "Sent" } },
      handler: async ({ params, body }, _req, res) => {
        await review.requestInfo(params.id, body.message, staffOf(res));
        res.status(204).end();
      },
    }),
    defineRoute({
      method: "post",
      path: `${CONSOLE}/:id/approve`,
      summary: "Approve (provisioning follows in P1-3)",
      tags: consoleTags,
      access: access.platform("platform.applications.approve"),
      request: {
        params: idParams,
        body: z.object({
          trialDays: z.number().int().min(0).max(90).optional(),
          note: z.string().trim().max(1_000).optional(),
        }),
      },
      responses: { 204: { description: "Approved" } },
      handler: async ({ params, body }, _req, res) => {
        await review.approve(params.id, staffOf(res), body);
        res.status(204).end();
      },
    }),
    defineRoute({
      method: "post",
      path: `${CONSOLE}/:id/reject`,
      summary: "Reject (with a reason; optionally shown to the applicant)",
      tags: consoleTags,
      access: access.platform("platform.applications.reject"),
      request: {
        params: idParams,
        body: z.object({
          reason: z.string().trim().min(5).max(1_000),
          notifyApplicantOfReason: z.boolean().default(false),
          reapplyAfterDays: z.number().int().min(0).max(365).optional(),
        }),
      },
      responses: { 204: { description: "Rejected" } },
      handler: async ({ params, body }, _req, res) => {
        await review.reject(params.id, staffOf(res), body);
        res.status(204).end();
      },
    }),
  ];
}
