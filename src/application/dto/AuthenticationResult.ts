/** Tokens returned to a client after sign-in or refresh. */
export type AuthenticationResult = Readonly<{
  sessionId: string;
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
}>;
