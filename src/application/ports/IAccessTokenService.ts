/**
 * Who a short-lived access token speaks for. Tenant tokens are bound to one tenant; platform
 * tokens (admin console) belong to a separate audience and are never valid on tenant routes.
 */
export type AccessTokenSubject =
  | Readonly<{
      audience: "tenant";
      tenantId: string;
      userId: string;
      sessionId: string;
      permissionVersion: number;
      /**
       * Support access (docs/27 §3.8): staff acting in the tenant through this support session
       * (`sessionId` is then the support session, `userId` the tenant user whose permissions apply).
       */
      support?: boolean;
    }>
  | Readonly<{
      audience: "platform";
      userId: string;
      sessionId: string;
      permissionVersion: number;
    }>;

export type IssuedAccessToken = Readonly<{ token: string; expiresAt: Date }>;

export interface IAccessTokenService {
  issue(subject: AccessTokenSubject): Promise<IssuedAccessToken>;
  /**
   * Verifies signature, issuer, audience and expiry. Throws InvalidAccessTokenError on any
   * problem (the reason is logged, never returned to the client).
   */
  verify<A extends AccessTokenSubject["audience"]>(
    token: string,
    audience: A,
  ): Promise<Extract<AccessTokenSubject, { audience: A }>>;
}
