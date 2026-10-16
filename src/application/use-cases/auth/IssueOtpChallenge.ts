import { OtpChallenge } from "../../../domain/entities/OtpChallenge.js";
import type { OtpPurpose } from "../../../domain/enums/OtpPurpose.js";
import type { IOtpChallengeRepository } from "../../../domain/repositories/IOtpChallengeRepository.js";
import type { IssuedOtp } from "../../dto/IssuedOtp.js";
import type { IClock } from "../../ports/IClock.js";
import type { IIdGenerator } from "../../ports/IIdGenerator.js";
import type { IOtpService } from "../../ports/IOtpService.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";

export type OtpSettings = Readonly<{ ttlMs: number; maxAttempts: number }>;

export type IssueOtpChallengeCommand = Readonly<{ subject: string; purpose: OtpPurpose }>;

/**
 * Issues a new one-time code for a subject and purpose, invalidating any open one. The caller
 * delivers the returned code (email/SMS, P0-8) and must never log or return it to the client.
 * Resend throttling is applied by the route's rate limiter. Runs in the current tenant context.
 */
export class IssueOtpChallenge {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      challenges: IOtpChallengeRepository;
      otp: IOtpService;
      ids: IIdGenerator;
      clock: IClock;
      settings: OtpSettings;
    }>,
  ) {}

  async execute(command: IssueOtpChallengeCommand): Promise<IssuedOtp> {
    const { deps } = this;
    const code = deps.otp.generateCode();
    return deps.unitOfWork.run(async () => {
      const now = deps.clock.now();
      const open = await deps.challenges.findOpen(command.subject, command.purpose);
      if (open !== null) {
        open.invalidate(now);
        await deps.challenges.save(open);
      }
      const challenge = OtpChallenge.issue({
        id: deps.ids.next(),
        subject: command.subject,
        purpose: command.purpose,
        codeHash: deps.otp.hash(command.subject, command.purpose, code),
        now,
        ttlMs: deps.settings.ttlMs,
        maxAttempts: deps.settings.maxAttempts,
      });
      await deps.challenges.save(challenge);
      return { challengeId: challenge.id, code, expiresAt: challenge.expiresAt };
    });
  }
}
