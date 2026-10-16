import type { OtpPurpose } from "../../../domain/enums/OtpPurpose.js";
import type { OtpVerificationOutcome } from "../../../domain/entities/OtpChallenge.js";
import type { IOtpChallengeRepository } from "../../../domain/repositories/IOtpChallengeRepository.js";
import { OtpVerificationFailedError } from "../../errors/AuthErrors.js";
import type { IClock } from "../../ports/IClock.js";
import type { IOtpService } from "../../ports/IOtpService.js";
import type { IUnitOfWork } from "../../ports/IUnitOfWork.js";

export type VerifyOtpChallengeCommand = Readonly<{
  subject: string;
  purpose: OtpPurpose;
  code: string;
}>;

/**
 * Checks a code against the open challenge for the subject and purpose. A correct code consumes
 * the challenge; each wrong one counts towards the lock. The attempt is committed before a
 * failure is thrown, so failed guesses cannot be retried for free. Runs in the current tenant
 * context.
 */
export class VerifyOtpChallenge {
  constructor(
    private readonly deps: Readonly<{
      unitOfWork: IUnitOfWork;
      challenges: IOtpChallengeRepository;
      otp: IOtpService;
      clock: IClock;
    }>,
  ) {}

  async execute(command: VerifyOtpChallengeCommand): Promise<void> {
    const { deps } = this;
    const result = await deps.unitOfWork.run(
      async (): Promise<{ outcome: OtpVerificationOutcome | "not_found"; remaining?: number }> => {
        const challenge = await deps.challenges.lockOpen(command.subject, command.purpose);
        if (challenge === null) return { outcome: "not_found" };

        const matches = deps.otp.matches(
          challenge.codeHash,
          command.subject,
          command.purpose,
          command.code,
        );
        const outcome = challenge.attempt(matches, deps.clock.now());
        await deps.challenges.save(challenge);
        return { outcome, remaining: challenge.remainingAttempts };
      },
    );

    if (result.outcome === "verified") return;
    throw new OtpVerificationFailedError(
      result.outcome,
      result.outcome === "invalid" ? result.remaining : undefined,
    );
  }
}
