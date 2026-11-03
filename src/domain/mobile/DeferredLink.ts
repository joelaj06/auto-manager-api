import { randomInt } from "node:crypto";

/** Crockford base32: no I, L, O or U, so a code survives being read out or typed. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const LENGTH = 10;

/** A claim code: about 50 bits, shown as XXXXX-XXXXX. */
export function deferredCode(): string {
  let code = "";
  for (let i = 0; i < LENGTH; i += 1) code += ALPHABET[randomInt(ALPHABET.length)];
  return `${code.slice(0, 5)}-${code.slice(5)}`;
}

/**
 * The code as typed, or inside the resume link the clipboard carried; null when it cannot be one.
 * Letters easily mistyped read as the digits they look like.
 */
export function normaliseDeferredCode(input: string): string | null {
  const fromLink = /[?&]hold=([^&#]+)/.exec(input)?.[1];
  const raw = fromLink === undefined ? input : decodeURIComponent(fromLink);
  const code = raw.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  if (code.length !== LENGTH) return null;
  return [...code].every((c) => ALPHABET.includes(c)) ? code : null;
}
