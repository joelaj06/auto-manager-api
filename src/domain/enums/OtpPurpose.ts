/** What a one-time code is for; a code issued for one purpose never verifies another. */
export const OTP_PURPOSES = [
  "email_verification",
  "phone_verification",
  "password_reset",
  "login_verification",
  "document_signing",
  "billing_extension",
] as const;

export type OtpPurpose = (typeof OTP_PURPOSES)[number];

export function isOtpPurpose(value: unknown): value is OtpPurpose {
  return typeof value === "string" && (OTP_PURPOSES as readonly string[]).includes(value);
}
