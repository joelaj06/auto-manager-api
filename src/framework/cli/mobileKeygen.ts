import { generateKeyPairSync } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { Ed25519ConnectLinkSigner } from "../../infrastructure/mobile/Ed25519ConnectLinkSigner.js";
import { log, runCommand } from "./runCommand.js";

/**
 * yarn mobile:keygen [--out file] — creates the Ed25519 key that signs mobile connect links.
 * Keep the file secret (MOBILE_CONNECT_KEY_FILE); give the printed key id and public key to the
 * app builds, which embed them. Never overwrites an existing file.
 */
runCommand("mobile:keygen", () => {
  const { values } = parseArgs({
    options: { out: { type: "string", default: "mobile-connect.key.pem" } },
  });
  const out = values.out;
  if (existsSync(out)) {
    console.error(
      `${out} already exists; choose another --out. To rotate: ship the new public key in the app first, then switch the server to the new file.`,
    );
    return Promise.resolve(1);
  }
  const pem = String(
    generateKeyPairSync("ed25519").privateKey.export({ format: "pem", type: "pkcs8" }),
  );
  writeFileSync(out, pem, { mode: 0o600, flag: "wx" });
  const [key] = Ed25519ConnectLinkSigner.fromPem(pem).publicKeys();
  log(`private key written to ${out} (mode 600) — set MOBILE_CONNECT_KEY_FILE=${out}`);
  log(`key id:     ${key!.keyId}`);
  log(`public key: ${key!.publicKey}   (Ed25519, raw, base64url — embed in the app)`);
  return Promise.resolve(0);
});
