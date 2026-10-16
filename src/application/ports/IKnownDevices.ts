/** Devices a staff member has signed in from (for "new sign-in" alerts). */
export interface IKnownDevices {
  /** Records the device; true when it was not seen before. */
  remember(userId: string, deviceHash: string, now: Date): Promise<boolean>;
}
