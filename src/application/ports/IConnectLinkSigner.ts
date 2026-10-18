export type ConnectPublicKey = Readonly<{
  keyId: string;
  algorithm: "Ed25519";
  /** Raw 32-byte public key, base64url — what the mobile app embeds. */
  publicKey: string;
}>;

/** Signs mobile connect links with the platform key (never leaves the server). */
export interface IConnectLinkSigner {
  readonly keyId: string;
  /** base64url signature of `message`. */
  sign(message: string): string;
  verify(message: string, signature: string, keyId: string): boolean;
  knowsKey(keyId: string): boolean;
  publicKeys(): readonly ConnectPublicKey[];
}

/** Renders text as a QR code (SVG markup). */
export interface IQrCodeRenderer {
  svg(text: string): Promise<string>;
}
