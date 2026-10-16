import { hkdfSync, randomUUID } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import { InvalidChallengeError } from "../../application/errors/StaffErrors.js";
import type { IClock } from "../../application/ports/IClock.js";
import type {
  IStaffChallenges,
  StaffChallengePurpose,
} from "../../application/ports/IStaffChallenges.js";

const AUDIENCE = "autoforce:platform-challenge";
const TTL_SECONDS = 300;

/**
 * Sign-in step tokens: HS256, 5 minutes, signed with a key derived from PLATFORM_JWT_SECRET for
 * this purpose only (never valid as an access token). They carry the staff id and the next step.
 */
export class JwtStaffChallenges implements IStaffChallenges {
  private readonly key: Uint8Array;

  constructor(
    platformSecret: string,
    private readonly issuer: string,
    private readonly clock: IClock,
  ) {
    this.key = new Uint8Array(
      hkdfSync("sha256", platformSecret, "autoforce-staff-challenge-v1", "staff-challenge", 32),
    );
  }

  async issue(userId: string, purpose: StaffChallengePurpose) {
    const now = Math.floor(this.clock.now().getTime() / 1000);
    const token = await new SignJWT({ purpose })
      .setProtectedHeader({ alg: "HS256", typ: "staff-challenge+jwt" })
      .setSubject(userId)
      .setIssuer(this.issuer)
      .setAudience(AUDIENCE)
      .setJti(randomUUID())
      .setIssuedAt(now)
      .setExpirationTime(now + TTL_SECONDS)
      .sign(this.key);
    return { token, expiresAt: new Date((now + TTL_SECONDS) * 1000) };
  }

  async verify(token: string, purpose: StaffChallengePurpose): Promise<string> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        algorithms: ["HS256"],
        typ: "staff-challenge+jwt",
        issuer: this.issuer,
        audience: AUDIENCE,
        currentDate: this.clock.now(),
        requiredClaims: ["sub", "exp"],
      });
      if (payload.purpose !== purpose || typeof payload.sub !== "string") {
        throw new InvalidChallengeError("wrong_purpose");
      }
      return payload.sub;
    } catch (error) {
      if (error instanceof InvalidChallengeError) throw error;
      throw new InvalidChallengeError("invalid");
    }
  }
}
