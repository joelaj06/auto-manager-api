import { pageHeaders } from "../presenters/pageHeaders.js";
import { pageParams } from "../validators/commonRequests.js";
import { z } from "zod";
import type { ApiKeys } from "../../application/use-cases/integrations/ApiKeys.js";
import type { Webhooks } from "../../application/use-cases/integrations/Webhooks.js";
import { principalOf } from "../middleware/AccessGuard.js";
import { envelope } from "../presenters/responseEnvelope.js";
import { defineRoute, type ApiRoute } from "./ApiRoute.js";
import { access } from "./RouteAccess.js";

const BASE = "/api/v1/integrations";
const tags = ["integrations"];
const view = access.permission("integrations.view");
const manage = access.permission("integrations.manage");
const idParams = z.object({ id: z.uuid() });
const url = z.string().trim().min(8).max(2_000);
const description = z.string().trim().max(200).nullish();
const events = z.array(z.string().max(60)).min(1).max(200);

export type IntegrationRouteDependencies = Readonly<{ keys: ApiKeys; webhooks: Webhooks }>;

/**
 * What an Enterprise business connects to its own systems (decisions 523–527): API keys that act
 * as their maker within their scopes, and webhooks that tell an address what changed.
 */
export function integrationRoutes(deps: IntegrationRouteDependencies): ApiRoute[] {
  const { keys, webhooks } = deps;
  return [
    defineRoute({
      method: "get",
      path: `${BASE}/api-key-scopes`,
      summary: "What an API key can be given",
      tags,
      access: view,
      responses: { 200: { description: "Scopes" } },
      handler: (_input, _req, res) => {
        res.json(envelope(keys.scopes()));
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/api-keys`,
      summary: "The business's API keys with their last use and requests counted",
      tags,
      access: view,
      request: {
        query: z.object({ includeRevoked: z.stringbool().optional() }),
      },
      responses: { 200: { description: "Keys, never the keys themselves" } },
      handler: async ({ query }, _req, res) => {
        res.json(envelope(await keys.list(query.includeRevoked ?? false)));
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/api-keys`,
      summary: "Creates an API key acting as you within its scopes; it is shown this once",
      tags,
      access: manage,
      request: {
        body: z.object({
          name: z.string().trim().min(1).max(100),
          scopes: z.array(z.string().max(100)).min(1).max(300),
          expiresAt: z.coerce.date().nullish(),
        }),
      },
      responses: {
        201: { description: "The key" },
        403: { description: "The business has no Enterprise licence" },
      },
      handler: async ({ body }, _req, res) => {
        res.status(201).json(envelope(await keys.create(principalOf(res), body)));
      },
    }),
    defineRoute({
      method: "delete",
      path: `${BASE}/api-keys/:id`,
      summary: "Revokes an API key at once",
      tags,
      access: manage,
      request: { params: idParams },
      responses: { 204: { description: "Revoked" } },
      handler: async ({ params }, _req, res) => {
        await keys.revoke(principalOf(res), params.id);
        res.status(204).end();
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/webhook-events`,
      summary: "The events a webhook can subscribe to",
      tags,
      access: view,
      responses: { 200: { description: "Events" } },
      handler: (_input, _req, res) => {
        res.json(envelope(webhooks.events()));
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/webhooks`,
      summary: "The business's webhook addresses",
      tags,
      access: view,
      responses: { 200: { description: "Addresses" } },
      handler: async (_input, _req, res) => {
        res.json(envelope(await webhooks.list()));
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/webhooks`,
      summary: "Adds an https address; the signing secret is shown this once",
      tags,
      access: manage,
      request: { body: z.object({ url, description, events }) },
      responses: {
        201: { description: "The address and its secret" },
        403: { description: "The business has no Enterprise licence" },
      },
      handler: async ({ body }, _req, res) => {
        res.status(201).json(envelope(await webhooks.create(principalOf(res), body)));
      },
    }),
    defineRoute({
      method: "patch",
      path: `${BASE}/webhooks/:id`,
      summary: "Edits an address, its events, or switches it off and on",
      tags,
      access: manage,
      request: {
        params: idParams,
        body: z.object({ url, description, events, enabled: z.boolean() }).partial(),
      },
      responses: { 200: { description: "The address" } },
      handler: async ({ params, body }, _req, res) => {
        res.json(envelope(await webhooks.update(principalOf(res), params.id, body)));
      },
    }),
    defineRoute({
      method: "delete",
      path: `${BASE}/webhooks/:id`,
      summary: "Removes an address and its deliveries",
      tags,
      access: manage,
      request: { params: idParams },
      responses: { 204: { description: "Removed" } },
      handler: async ({ params }, _req, res) => {
        await webhooks.remove(principalOf(res), params.id);
        res.status(204).end();
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/webhooks/:id/rotate-secret`,
      summary: "Replaces the signing secret; the new one is shown this once",
      tags,
      access: manage,
      request: { params: idParams },
      responses: { 200: { description: "The new secret" } },
      handler: async ({ params }, _req, res) => {
        res.json(envelope(await webhooks.rotateSecret(principalOf(res), params.id)));
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/webhooks/:id/test`,
      summary: "Sends a harmless webhook.test event to the address",
      tags,
      access: manage,
      request: { params: idParams },
      responses: { 202: { description: "Queued" } },
      handler: async ({ params }, _req, res) => {
        res.status(202).json(envelope(await webhooks.test(principalOf(res), params.id)));
      },
    }),
    defineRoute({
      method: "get",
      path: `${BASE}/webhooks/:id/deliveries`,
      summary: "What was sent to an address and how it answered, newest first",
      tags,
      access: view,
      request: {
        params: idParams,
        query: z.object(pageParams(200, 50)),
      },
      responses: { 200: { description: "Deliveries" } },
      handler: async ({ params, query }, _req, res) => {
        const page = await webhooks.deliveries(params.id, query);
        res.set(pageHeaders(page)).json(envelope(page.items));
      },
    }),
    defineRoute({
      method: "post",
      path: `${BASE}/webhook-deliveries/:id/replay`,
      summary: "Sends a finished delivery again, the same event with the same id",
      tags,
      access: manage,
      request: { params: idParams },
      responses: { 202: { description: "Queued" } },
      handler: async ({ params }, _req, res) => {
        await webhooks.replay(principalOf(res), params.id);
        res.status(202).end();
      },
    }),
  ];
}
