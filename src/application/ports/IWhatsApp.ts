import type { WhatsAppStatus } from "../../domain/notifications/WhatsAppWebhook.js";

/** The business's own WhatsApp Business account on the Cloud API (decision 515). */
export type WhatsAppAccount = Readonly<{
  /** The sending number's id at Meta. */
  phoneNumberId: string;
  /** The number as customers see it, for the settings page. */
  displayNumber: string;
  /** accessToken, appSecret and verifyToken, sealed (never returned by the API). */
  sealedCredentials: string;
  updatedAt: string;
}>;

export type WhatsAppCredentials = Readonly<{
  accessToken: string;
  appSecret: string;
  verifyToken: string;
}>;

export type WhatsAppMessage = Readonly<{
  template: string;
  language: string;
  parameters: readonly string[];
}>;

/** Sends one approved template with the business's own account. */
export interface IWhatsAppGateway {
  /** `to` in E.164 (+233…). Throws SmsProviderError when the provider refuses. */
  send(
    account: Readonly<{ phoneNumberId: string; accessToken: string }>,
    to: string,
    message: WhatsAppMessage,
  ): Promise<Readonly<{ messageId: string }>>;
}

/** Numbers that asked not to get WhatsApp messages from the business. */
export interface IWhatsAppOptOuts {
  isOptedOut(phone: string): Promise<boolean>;
  optOut(phone: string, now: Date): Promise<void>;
  optIn(phone: string): Promise<void>;
}

export type { WhatsAppStatus };
