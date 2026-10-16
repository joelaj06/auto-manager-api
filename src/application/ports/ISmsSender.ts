/** Platform SMS (signup verification). Tenants' own SMS accounts are a separate port (decision 17). */
export interface ISmsSender {
  /** Returns the provider's message id. Throws when the provider rejects the message. */
  send(to: string, text: string): Promise<string>;
}
