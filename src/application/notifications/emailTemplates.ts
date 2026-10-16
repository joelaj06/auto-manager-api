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

  "platform.staff_invitation": Readonly<{
    name: string;
    invitedBy: string | null;
    acceptUrl: string;
    expiresInHours: number;
  }>;
  "platform.new_sign_in": Readonly<{
    name: string;
    at: string;
    ip: string | null;
    device: string | null;
  }>;
  "platform.staff_locked": Readonly<{ staffEmail: string; at: string; ip: string | null }>;
  "platform.approval_requested": Readonly<{ requestedBy: string; summary: string; reason: string }>;
  "application.verify_email": Readonly<{
    contactName: string;
    businessName: string;
    code: string;
    expiresInMinutes: number;
    applicationUrl: string;
  }>;
  "application.received": Readonly<{
    contactName: string;
    businessName: string;
    applicationUrl: string | null;
  }>;
  "application.info_requested": Readonly<{
    contactName: string;
    businessName: string;
    message: string;
    applicationUrl: string;
  }>;
  "application.approved": Readonly<{ contactName: string; businessName: string }>;
  "application.rejected": Readonly<{
    contactName: string;
    businessName: string;
    reason: string | null;
  }>;
  "tenant.deactivated": Readonly<{
    ownerName: string;
    businessName: string;
    message: string | null;
  }>;
  "tenant.restored": Readonly<{ ownerName: string; businessName: string; message: string | null }>;
  "tenant.welcome_owner": Readonly<{
    ownerName: string;
    businessName: string;
    slug: string;
    setPasswordUrl: string;
    expiresInHours: number;
    trialDays: number;
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

const CONSOLE = `${PRODUCT} console`;

function simple(subject: string, paragraphs: readonly string[]): RenderedEmail {
  return {
    subject,
    text: paragraphs.join("\n\n"),
    html: layout(subject, paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join("\n")),
  };
}

const renderers: { [K in EmailTemplateKey]: (data: EmailTemplateData[K]) => RenderedEmail } = {
  "platform.staff_invitation": (data) => {
    const subject = `You're invited to the ${CONSOLE}`;
    const by = data.invitedBy === null ? "" : ` by ${data.invitedBy}`;
    const text = [
      greeting(data.name),
      "",
      `You have been invited${by} to the ${CONSOLE}.`,
      `Accept the invitation and set up your account: ${data.acceptUrl}`,
      "",
      `The link expires in ${data.expiresInHours} hours and works once. You will set a password and an authenticator app.`,
    ].join("\n");
    const html = layout(
      subject,
      `<p>${escapeHtml(greeting(data.name))}</p>
<p>You have been invited${escapeHtml(by)} to the ${escapeHtml(CONSOLE)}.</p>
<p><a href="${escapeHtml(data.acceptUrl)}" style="display:inline-block;padding:10px 16px;background:#1f6feb;color:#fff;border-radius:6px;text-decoration:none">Accept invitation</a></p>
<p>The link expires in ${data.expiresInHours} hours and works once. You will set a password and an authenticator app.</p>`,
    );
    return { subject, text, html };
  },
  "platform.new_sign_in": (data) =>
    simple(`New sign-in to the ${CONSOLE}`, [
      greeting(data.name),
      `Your account signed in from a new device at ${data.at}${data.ip === null ? "" : ` (IP ${data.ip})`}${data.device === null ? "" : ` using ${data.device}`}.`,
      "If this was not you, contact a Super Admin immediately to disable your account.",
    ]),
  "platform.staff_locked": (data) =>
    simple(`Security alert: staff account locked`, [
      `The staff account ${data.staffEmail} was locked at ${data.at} after repeated failed sign-in attempts${data.ip === null ? "" : ` from IP ${data.ip}`}.`,
      "It unlocks automatically in 15 minutes. Check the audit log if this is unexpected.",
    ]),
  "platform.approval_requested": (data) =>
    simple(`Approval needed: ${data.summary}`, [
      `${data.requestedBy} asked for approval: ${data.summary}.`,
      `Reason: ${data.reason}`,
      `Review it in the ${CONSOLE} under Approvals.`,
    ]),
  "application.verify_email": (data) =>
    simple(`${data.code} is your ${PRODUCT} verification code`, [
      greeting(data.contactName),
      `Thank you for applying for ${PRODUCT} for ${data.businessName}.`,
      `Your email verification code is ${data.code}. It expires in ${data.expiresInMinutes} minutes.`,
      `You can follow your application and enter the codes here: ${data.applicationUrl}`,
      "Keep this link private — anyone with it can see and answer your application.",
    ]),
  "application.received": (data) =>
    simple(`We received your application for ${data.businessName}`, [
      greeting(data.contactName),
      `Your email and phone are verified and your application for ${data.businessName} is now with our team. We usually review applications within one working day.`,
      ...(data.applicationUrl === null ? [] : [`Follow its status here: ${data.applicationUrl}`]),
    ]),
  "application.info_requested": (data) =>
    simple(`We need a little more information about ${data.businessName}`, [
      greeting(data.contactName),
      `Our team reviewed your application and asked: ${data.message}`,
      `Reply here (this link replaces earlier ones): ${data.applicationUrl}`,
    ]),
  "application.approved": (data) =>
    simple(`Your ${PRODUCT} application is approved`, [
      greeting(data.contactName),
      `Good news — ${data.businessName} has been approved. We are setting up your account now and will email your sign-in details shortly.`,
    ]),
  "application.rejected": (data) =>
    simple(`About your ${PRODUCT} application`, [
      greeting(data.contactName),
      `We are sorry, but we cannot accept the application for ${data.businessName} at this time.`,
      ...(data.reason === null ? [] : [`Reason: ${data.reason}`]),
      "If you think this is a mistake, reply to this email or contact our support team.",
    ]),
  "tenant.deactivated": (data) =>
    simple(`${data.businessName} has been deactivated`, [
      greeting(data.ownerName),
      `Access to ${PRODUCT} for ${data.businessName} has been switched off. Nobody in your business can sign in until it is restored. Your data is kept safely and nothing has been deleted.`,
      ...(data.message === null ? [] : [data.message]),
      "Reply to this email or contact our support team to restore access.",
    ]),
  "tenant.restored": (data) =>
    simple(`${data.businessName} is active again`, [
      greeting(data.ownerName),
      `Access to ${PRODUCT} for ${data.businessName} has been restored. Everyone can sign in again; all your data is as it was.`,
    ]),
  "tenant.welcome_owner": (data) =>
    simple(`Welcome to ${PRODUCT} — ${data.businessName} is ready`, [
      greeting(data.ownerName),
      `Your account for ${data.businessName} is ready. Your business address is "${data.slug}", and your ${data.trialDays}-day trial starts now.`,
      `Set your password and sign in: ${data.setPasswordUrl}`,
      `The link works once and expires in ${data.expiresInHours} hours. You are the owner and can invite your team after signing in.`,
    ]),
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
