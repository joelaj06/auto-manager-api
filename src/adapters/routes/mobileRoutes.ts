import { z } from "zod";
import type { MobileConnect } from "../../application/use-cases/mobile/MobileConnect.js";
import { tenantOf } from "../middleware/AccessGuard.js";
import { connectLandingPage } from "../presenters/connectLandingPage.js";
import { envelope } from "../presenters/responseEnvelope.js";
import { defineRoute, type ApiRoute } from "./ApiRoute.js";
import { access } from "./RouteAccess.js";

/**
 * Mobile onboarding (docs/23): the business's signed connect link and QR code, the public keys
 * the app embeds, link diagnostics for the console, app-link metadata files and the landing
 * page shown when the app is not installed.
 */
export function mobileRoutes(mobile: MobileConnect): ApiRoute[] {
  return [
    defineRoute({
      method: "get",
      path: "/api/v1/mobile/connect-link",
      summary: "The signed link and QR code that connect the mobile app to your business",
      tags: ["mobile"],
      access: access.permission("settings.mobile.connect"),
      responses: { 200: { description: "Link (`url` for the QR), app link and QR code (SVG)" } },
      handler: async (_input, _req, res) => {
        res
          .set("Cache-Control", "no-store")
          .json(envelope(await mobile.connectLink(tenantOf(res).id)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/api/v1/public/mobile/connect-keys",
      summary: "Public keys connect links are signed with (embedded in app builds)",
      tags: ["public"],
      access: access.public(),
      responses: { 200: { description: "Ed25519 public keys by key id" } },
      handler: (_input, _req, res) => {
        res.set("Cache-Control", "public, max-age=3600").json(envelope(mobile.publicKeys()));
      },
    }),
    defineRoute({
      method: "post",
      path: "/api/platform/v1/mobile/connect-links/verify",
      summary: "Check a connect link as the app would (signature, server, business, expiry)",
      tags: ["console: mobile"],
      access: access.platform("platform.mobile.view"),
      request: { body: z.object({ link: z.string().trim().min(10).max(2_000) }) },
      responses: { 200: { description: "valid (with warnings) or the reason it is refused" } },
      handler: async ({ body }, _req, res) => {
        res.json(envelope(await mobile.verify(body.link)));
      },
    }),
    defineRoute({
      method: "get",
      path: "/.well-known/assetlinks.json",
      summary: "Android App Links verification",
      tags: ["mobile"],
      access: access.public(),
      responses: {
        200: { description: "Digital Asset Links" },
        404: { description: "Not set up" },
      },
      handler: (_input, _req, res) => {
        const links = mobile.assetLinks();
        if (links === null) res.status(404).end();
        else res.set("Cache-Control", "public, max-age=3600").json(links);
      },
    }),
    defineRoute({
      method: "get",
      path: "/.well-known/apple-app-site-association",
      summary: "iOS Universal Links verification",
      tags: ["mobile"],
      access: access.public(),
      responses: { 200: { description: "AASA file" }, 404: { description: "Not set up" } },
      handler: (_input, _req, res) => {
        const aasa = mobile.appleAppSiteAssociation();
        if (aasa === null) res.status(404).end();
        else res.set("Cache-Control", "public, max-age=3600").json(aasa);
      },
    }),
    defineRoute({
      method: "get",
      path: "/connect",
      summary: "Landing page of connect links (open the app, or get it)",
      tags: ["mobile"],
      access: access.public(),
      responses: { 200: { description: "HTML page" } },
      handler: async (_input, req, res) => {
        const query = req.originalUrl.split("?")[1] ?? "";
        res
          .status(200)
          .type("html")
          .set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" })
          .send(connectLandingPage(await mobile.landingPage(query)));
      },
    }),
  ];
}
