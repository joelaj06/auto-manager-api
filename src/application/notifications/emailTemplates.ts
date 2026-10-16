/**
 * Platform email templates (English first; other languages later — docs/15 §1). Each template
 * declares its data and renders subject, plain text and HTML. All values are HTML-escaped in the
 * HTML part; templates never interpolate raw markup.
 *
 * Modules add their templates here as they are built.
 */
export type EmailTemplateData = {
  "auth.otp_code": Readonly<{
    recipientName: string | null;
    code: string;
    purpose: string;
    expiresInMinutes: number;
    businessName: string | null;
  }>;
};

export type EmailTemplateKey = keyof EmailTemplateData;

export type RenderedEmail = Readonly<{ subject: string; text: string; html: string }>;

const PRODUCT = "Autoforce Manager";

const PURPOSE_TEXT: Readonly<Record<string, string>> = {
  email_verification: "verify your email address",
  phone_verification: "verify your phone number",
  password_reset: "reset your password",
  login_verification: "finish signing in",
  document_signing: "sign the document",
  billing_extension: "confirm the billing extension request",
};

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Shared HTML frame. `bodyHtml` must already be escaped. */
function layout(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:24px;background:#f4f5f7;font-family:Arial,Helvetica,sans-serif;color:#1f2933">
<div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:8px;padding:24px">
${bodyHtml}
<p style="margin-top:32px;font-size:12px;color:#6b7280">${PRODUCT}. If you did not expect this email, you can ignore it.</p>
</div>
</body>
</html>`;
}

const greeting = (name: string | null) => (name === null ? "Hello," : `Hello ${name},`);

const renderers: { [K in EmailTemplateKey]: (data: EmailTemplateData[K]) => RenderedEmail } = {
  "auth.otp_code": (data) => {
    const action = PURPOSE_TEXT[data.purpose] ?? "continue";
    const where = data.businessName === null ? PRODUCT : `${data.businessName} on ${PRODUCT}`;
    const subject = `${data.code} is your ${PRODUCT} code`;
    const text = [
      greeting(data.recipientName),
      "",
      `Use this code to ${action} (${where}):`,
      "",
      data.code,
      "",
      `It expires in ${data.expiresInMinutes} minutes. Never share it with anyone — our staff will never ask for it.`,
    ].join("\n");
    const html = layout(
      subject,
      `<p>${escapeHtml(greeting(data.recipientName))}</p>
<p>Use this code to ${escapeHtml(action)} (${escapeHtml(where)}):</p>
<p style="font-size:28px;letter-spacing:6px;font-weight:bold">${escapeHtml(data.code)}</p>
<p>It expires in ${data.expiresInMinutes} minutes. Never share it with anyone — our staff will never ask for it.</p>`,
    );
    return { subject, text, html };
  },
};

export function renderEmail<K extends EmailTemplateKey>(
  template: K,
  data: EmailTemplateData[K],
): RenderedEmail {
  return renderers[template](data);
}
