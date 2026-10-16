/**
 * Message keys already handled in the current tenant database. Call inside the unit of work of
 * the handler's changes, so the key commits if and only if the changes do.
 */
export interface IProcessedMessages {
  /** Records the key; false when it was already recorded (the message is a redelivery). */
  markProcessed(key: string): Promise<boolean>;
}
