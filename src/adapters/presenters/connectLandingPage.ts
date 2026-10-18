import type { LandingPage } from "../../application/use-cases/mobile/MobileConnect.js";

const escape = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const button = (href: string, label: string) =>
  `<a href="${escape(href)}" style="display:block;margin:12px 0;padding:14px;border-radius:8px;` +
  `background:#0f5132;color:#fff;text-decoration:none;text-align:center;font-weight:600">` +
  `${escape(label)}</a>`;

/**
 * The page a phone shows for a connect link when the app does not open it (docs/23 §3): open
 * the app, or get it. No scripts; every value is escaped.
 */
export function connectLandingPage(page: LandingPage): string {
  const body: string[] = [];
  if (page.valid && page.tenantSlug !== null) {
    body.push(
      `<h1 style="font-size:22px">Connect to “${escape(page.tenantSlug)}”</h1>`,
      "<p>Open this link in the Autoforce Manager app to connect to this business.</p>",
    );
    if (page.appUrl !== null) body.push(button(page.appUrl, "Open in the app"));
  } else {
    body.push(
      '<h1 style="font-size:22px">This link cannot be used</h1>',
      "<p>Ask your business for a new QR code or link.</p>",
    );
  }
  body.push("<p>Don't have the app yet?</p>");
  if (page.androidStoreUrl !== null)
    body.push(button(page.androidStoreUrl, "Get it on Google Play"));
  if (page.iosStoreUrl !== null) body.push(button(page.iosStoreUrl, "Download on the App Store"));
  if (page.androidStoreUrl === null && page.iosStoreUrl === null)
    body.push("<p>The app will be available in the stores soon.</p>");
  body.push(
    '<p style="color:#555;font-size:14px">After installing on iPhone, scan the QR code again.</p>',
  );
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="robots" content="noindex">',
    "<title>Autoforce Manager — Connect</title></head>",
    '<body style="font-family:system-ui,sans-serif;max-width:420px;margin:40px auto;padding:0 16px">',
    ...body,
    "</body></html>",
  ].join("\n");
}
