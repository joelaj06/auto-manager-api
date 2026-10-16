export type GeneratedRefreshToken = Readonly<{ token: string; hash: string }>;

/**
 * Opaque refresh tokens: `<sessionId>.<random secret>`. Only the hash is stored, so a database
 * leak does not reveal usable tokens.
 */
export interface IRefreshTokenService {
  generate(sessionId: string): GeneratedRefreshToken;
  /** Splits and hashes a presented token; null when it is malformed. */
  parse(token: string): Readonly<{ sessionId: string; hash: string }> | null;
}
