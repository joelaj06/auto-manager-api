/** One-way password hashing (Argon2id). Never store or log plain passwords. */
export interface IPasswordHasher {
  hash(password: string): Promise<string>;
  verify(hash: string, password: string): Promise<boolean>;
  /** True when the hash was made with weaker parameters and should be replaced on next login. */
  needsRehash(hash: string): boolean;
}
