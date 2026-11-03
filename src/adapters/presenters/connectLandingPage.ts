import type {
  DeferredHold,
  LandingPage,
} from "../../application/use-cases/mobile/MobileConnect.js";

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
 * the app, or get it, or on iPhone keep the link for after installing. No scripts; every value
 * is escaped.
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
  if (page.valid && page.iosStoreUrl !== null)
    body.push(
      `<form method="post" action="/connect"><input type="hidden" name="q" value="${escape(page.query ?? "")}">`,
      '<button style="display:block;width:100%;margin:12px 0;padding:14px;border-radius:8px;border:1px solid #0f5132;background:#fff;color:#0f5132;font:inherit;font-weight:600">',
      "On iPhone? Keep this link for after installing</button></form>",
    );
  return page_(body);
}

/**
 * The code that carries a connect link through the App Store (decision 518). A small script (with
 * the response's own nonce) puts the resume link on the clipboard as the button is tapped, so the
 * app can pick it up when it first opens; without it the button still goes to the store and the
 * code can be typed.
 */
export function connectHoldPage(
  hold: Pick<DeferredHold, "code" | "resumeUrl" | "iosStoreUrl">,
  nonce: string,
): string {
  const body = [
    '<h1 style="font-size:22px">Your connect code</h1>',
    `<p style="font-size:28px;font-weight:700;letter-spacing:2px;text-align:center;user-select:all">${escape(hold.code)}</p>`,
    "<p>Install the app, then open it: it picks this up by itself, or enter the code. It works once, for a day.</p>",
  ];
  if (hold.iosStoreUrl !== null)
    body.push(
      button(hold.iosStoreUrl, "Copy and go to the App Store").replace(
        "<a ",
        `<a id="store" data-copy="${escape(hold.resumeUrl)}" `,
      ),
    );
  body.push(button(hold.resumeUrl, "I have the app: open it"));
  body.push(
    `<script nonce="${escape(nonce)}">document.getElementById("store")?.addEventListener("click",function(e){` +
      "var a=e.currentTarget;navigator.clipboard&&navigator.clipboard.writeText(a.dataset.copy).catch(function(){});});</script>",
  );
  return page_(body);
}

function page_(body: readonly string[]): string {
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
