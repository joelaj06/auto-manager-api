import type { IssuedDocumentProps } from "../../domain/documents/IssuedDocument.js";

/**
 * A module that acts when one of its documents is signed by everyone (e.g. a transfer letter
 * completes the vehicle transfer). Called inside the signing transaction: a failure undoes the
 * last signature.
 */
export interface IDocumentSignedListener {
  readonly documentType: string;
  fullySigned(document: IssuedDocumentProps): Promise<void>;
}
