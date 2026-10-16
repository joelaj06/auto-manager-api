/** A freshly issued code, to be delivered by email/SMS by the caller. Never log `code`. */
export type IssuedOtp = Readonly<{ challengeId: string; code: string; expiresAt: Date }>;
