/** What the WhatsApp Cloud API tells us about a message we sent. */
export const WHATSAPP_STATUSES = ["sent", "delivered", "read", "failed"] as const;
export type WhatsAppStatus = (typeof WHATSAPP_STATUSES)[number];

export type WhatsAppStatusUpdate = Readonly<{
  messageId: string;
  status: WhatsAppStatus;
  at: Date;
  error: string | null;
  /** The number cannot get the message on WhatsApp: the text should go another way. */
  undeliverable: boolean;
}>;

export type WhatsAppInbound = Readonly<{ from: string; text: string }>;

export type WhatsAppWebhookContent = Readonly<{
  statuses: readonly WhatsAppStatusUpdate[];
  inbound: readonly WhatsAppInbound[];
}>;

/** Cloud API errors meaning this number will not get it: not on WhatsApp, or Meta holding it. */
const UNDELIVERABLE = new Set([131026, 131049, 131050, 130472]);

const STOP_WORDS = new Set(["stop", "unsubscribe", "cancel", "opt out", "optout"]);
const START_WORDS = new Set(["start", "subscribe", "opt in", "optin"]);

/** A reply asking to stop or to start messages; anything else is not for us to act on. */
export function optChoice(text: string): "out" | "in" | null {
  const word = text.trim().toLowerCase();
  if (STOP_WORDS.has(word)) return "out";
  if (START_WORDS.has(word)) return "in";
  return null;
}

const list = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : []);
const record = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
const text = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;

function status(raw: unknown): WhatsAppStatusUpdate | null {
  const r = record(raw);
  const messageId = text(r.id);
  const state = WHATSAPP_STATUSES.find((s) => s === r.status);
  const seconds = Number(r.timestamp);
  if (messageId === null || state === undefined || !Number.isFinite(seconds) || seconds <= 0)
    return null;
  const first = record(list(r.errors)[0]);
  const code = Number(first.code);
  const title = text(first.title) ?? text(first.message);
  return {
    messageId,
    status: state,
    at: new Date(seconds * 1_000),
    error: state === "failed" ? `${title ?? "Not delivered"} (${String(first.code)})` : null,
    undeliverable: state === "failed" && UNDELIVERABLE.has(code),
  };
}

/**
 * Reads a Cloud API webhook (`object: whatsapp_business_account`), keeping only what it knows:
 * Meta adds fields and event kinds freely, so anything else is passed over, never an error.
 */
export function parseWhatsAppWebhook(body: unknown): WhatsAppWebhookContent {
  const statuses: WhatsAppStatusUpdate[] = [];
  const inbound: WhatsAppInbound[] = [];
  for (const entry of list(record(body).entry))
    for (const change of list(record(entry).changes)) {
      const value = record(record(change).value);
      for (const raw of list(value.statuses)) {
        const update = status(raw);
        if (update !== null) statuses.push(update);
      }
      for (const raw of list(value.messages)) {
        const message = record(raw);
        const from = text(message.from);
        const body = text(record(message.text).body);
        if (from !== null && body !== null) inbound.push({ from: `+${from}`, text: body });
      }
    }
  return { statuses, inbound };
}
