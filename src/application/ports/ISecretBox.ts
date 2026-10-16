/** Authenticated encryption of small secrets at rest (e.g. TOTP secrets). */
export interface ISecretBox {
  seal(plaintext: string): string;
  /** Throws when the sealed value was modified or sealed with another key. */
  open(sealed: string): string;
}
