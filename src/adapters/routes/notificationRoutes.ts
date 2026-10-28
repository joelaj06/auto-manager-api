import { z } from "zod";
import type { NotificationCenter } from "../../application/use-cases/notifications/NotificationCenter.js";
import type { NotificationSettingsService } from "../../application/use-cases/notifications/NotificationSettingsService.js";
import { SMS_PROVIDERS } from "../../application/ports/INotifications.js";
import { CHANNELS, RULE_KEYS } from "../../domain/notifications/NotificationRules.js";
import { principalOf } from "../middleware/AccessGuard.js";
import { envelope } from "../presenters/responseEnvelope.js";
import { defineRoute, type ApiRoute } from "./ApiRoute.js";
import { access } from "./RouteAccess.js";

const uuid = z.uuid();
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:MM, e.g. 21:00");
const rule = z
  .object({
    enabled: z.boolean(),
    channels: z.array(z.enum(CHANNELS)).max(4),
    daysBefore: z.array(z.number().int().min(0).max(365)).min(1).max(6),
    afterDays: z.number().int().min(1).max(365),
    smsTemplate: z.string().max(459).nullable(),
  })
  .partial();

export type NotificationRouteDependencies = Readonly<{
  center: NotificationCenter;
  settings: NotificationSettingsService;
}>;

/** Notifications (docs/15): the staff inbox and push devices, settings, SMS account and log. */
export function notificationRoutes(deps: NotificationRouteDependencies): ApiRoute[] {
  const { center, settings } = deps;
  return [
    defineRoute({
      method: "get",
      path: "/api/v1/notifications",
      summary: "My notifications, newest first (`meta.unread`, `meta.nextCursor`)",
      tags: ["notifications"],
      access: access.signedIn(),
      request: {
        query: z.object({
          unreadOnly: z
            .enum(["true", "false"])
            .optional()
            .transform((v) => v === "true"),
          cursor: z.string().max(300).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(30),
        }),
      },
      responses: { 200: { description: "Notifications" } },
      handler: async ({ query }, _req, res) => {
        const page = await center.list(principalOf(res), query);
        res.json(envelope(page.items, { unread: page.unread, nextCursor: page.nextCursor }));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/notifications/unread-count",
      summary: "How many of my notifications are unread (the bell badge)",
      tags: ["notifications"],
      access: access.signedIn(),
      responses: { 200: { description: "Count" } },
      handler: async (_input, _req, res) => {
        res.json(envelope({ unread: await center.unreadCount(principalOf(res)) }));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/notifications/read",
      summary: "Mark notifications read (all of them without `ids`)",
      tags: ["notifications"],
      access: access.signedIn(),
      request: { body: z.object({ ids: z.array(uuid).min(1).max(200).optional() }) },
      responses: { 200: { description: "Unread left" } },
      handler: async ({ body }, _req, res) => {
        res.json(envelope({ unread: await center.markRead(principalOf(res), body.ids ?? null) }));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/me/push-devices",
      summary: "Register this app installation for push (FCM registration token)",
      tags: ["notifications"],
      access: access.signedIn(),
      request: {
        body: z.object({
          token: z.string().min(20).max(4096),
          platform: z.enum(["android", "ios", "web"]),
        }),
      },
      responses: { 204: { description: "Registered" } },
      handler: async ({ body }, _req, res) => {
        await center.registerDevice(principalOf(res), body.token, body.platform);
        res.status(204).end();
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/me/push-devices/unregister",
      summary: "Stop push to this app installation (on sign-out)",
      tags: ["notifications"],
      access: { kind: "authenticated", permission: null, allowWhenReadOnly: true },
      request: { body: z.object({ token: z.string().min(20).max(4096) }) },
      responses: { 204: { description: "Removed" } },
      handler: async ({ body }, _req, res) => {
        await center.removeDevice(principalOf(res), body.token);
        res.status(204).end();
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/settings/notifications",
      summary: "Notification settings: SMS provider (without credentials), quiet hours, rules",
      tags: ["settings"],
      access: access.permission("settings.view"),
      responses: { 200: { description: "Settings" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await settings.get()));
      },
    }),
    defineRoute({
      method: "patch",
      path: "/api/v1/settings/notifications",
      summary: "Change quiet hours, the remittance cut-off time or rules",
      tags: ["settings"],
      access: access.permission("settings.notifications.manage"),
      request: {
        body: z.object({
          quietHours: z.object({ start: time, end: time }).nullable().optional(),
          remittanceCutoff: time.optional(),
          rules: z.partialRecord(z.enum(RULE_KEYS), rule).optional(),
        }),
      },
      responses: { 200: { description: "Settings" } },
      handler: async ({ body }, _req, res) => {
        res.json(envelope(await settings.update(principalOf(res), body)));
      },
    }),
    defineRoute({
      method: "put",
      path: "/api/v1/settings/notifications/sms",
      summary: "Set the business's SMS provider account (Hubtel, Arkesel, mNotify)",
      tags: ["settings"],
      access: access.permission("settings.notifications.manage"),
      request: {
        body: z.object({
          provider: z.enum(SMS_PROVIDERS),
          senderId: z.string().max(20),
          credentials: z.record(z.string().max(40), z.string().max(500)),
        }),
      },
      responses: { 200: { description: "Settings (credentials are never returned)" } },
      handler: async ({ body }, _req, res) => {
        res.json(envelope(await settings.setSmsAccount(principalOf(res), body)));
      },
    }),
    defineRoute({
      method: "delete",
      path: "/api/v1/settings/notifications/sms",
      summary: "Remove the SMS provider account (SMS rules stop sending)",
      tags: ["settings"],
      access: access.permission("settings.notifications.manage"),
      responses: { 200: { description: "Settings" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await settings.removeSmsAccount(principalOf(res))));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/v1/settings/notifications/sms/test",
      summary: "Send a test SMS now through the provider account",
      tags: ["settings"],
      access: access.permission("settings.notifications.manage"),
      request: { body: z.object({ to: z.string().max(20) }) },
      responses: { 200: { description: "Delivery" }, 502: { description: "Provider refused" } },
      handler: async ({ body }, _req, res) => {
        res.json(envelope(await settings.testSms(principalOf(res), body.to)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/notification-deliveries",
      summary: "Log of SMS, push and email notifications sent, newest first",
      tags: ["notifications"],
      access: access.permission("notifications.deliveries.view"),
      request: {
        query: z.object({
          channel: z.enum(["sms", "push", "email"]).optional(),
          status: z.enum(["queued", "sent", "failed", "skipped"]).optional(),
          recipientId: uuid.optional(),
          cursor: z.string().max(300).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
      },
      responses: { 200: { description: "Deliveries; `meta.nextCursor` for the next page" } },
      handler: async ({ query }, _req, res) => {
        const page = await settings.deliveries(query);
        res.json(envelope(page.items, { nextCursor: page.nextCursor }));
      },
    }),
  ];
}
