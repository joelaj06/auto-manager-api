import argon2 from "argon2";
import type { IPasswordHasher } from "../../application/ports/IPasswordHasher.js";

/**
 * Argon2id with the OWASP minimum (19 MiB, 2 iterations, 1 lane): about 25 ms per hash on a
 * laptop, computed off the event loop by the native module.
 */
export type Argon2Options = Readonly<{
  type: typeof argon2.argon2id;
  memoryCost: number;
  timeCost: number;
  parallelism: number;
}>;

export const ARGON2_OPTIONS: Argon2Options = Object.freeze({
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
});

export class Argon2PasswordHasher implements IPasswordHasher {
  constructor(private readonly options: Argon2Options = ARGON2_OPTIONS) {}

  hash(password: string): Promise<string> {
    return argon2.hash(password, this.options);
  }

  async verify(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, password);
    } catch {
      // A malformed stored hash must not turn a login into a 500.
      return false;
    }
  }

  needsRehash(hash: string): boolean {
    try {
      return argon2.needsRehash(hash, this.options);
    } catch {
      return true;
    }
  }
}
