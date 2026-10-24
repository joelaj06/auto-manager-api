export type LegalKind = "terms" | "privacy" | "dpa";

export type LegalDocument = Readonly<{
  id: string;
  kind: LegalKind;
  version: string;
  title: string;
  body: string;
  summary: string | null;
  requiresAcceptance: boolean;
  status: "draft" | "published";
  effectiveAt: Date | null;
  publishedAt: Date | null;
  createdBy: string;
  createdAt: Date;
}>;

export type LegalAcceptance = Readonly<{
  documentId: string;
  tenantId: string | null;
  applicationId: string | null;
  tenantUserId: string | null;
  context: "signup" | "app";
  acceptedAt: Date;
  ip: string | null;
  userAgent: string | null;
}>;

/** Terms, privacy policy and DPA versions and who accepted them (platform database). */
export interface ILegalRepository {
  save(document: LegalDocument): Promise<void>;
  find(id: string, lock?: boolean): Promise<LegalDocument | null>;
  list(kind?: LegalKind): Promise<LegalDocument[]>;
  /** The version in force: the newest published one whose effective date has come. */
  current(kind: LegalKind, now: Date): Promise<LegalDocument | null>;
  versionTaken(kind: LegalKind, version: string): Promise<boolean>;
  accept(acceptance: LegalAcceptance): Promise<void>;
  /** When the tenant accepted it: its owner in the app, or its application at sign-up. */
  acceptedAt(documentId: string, tenantId: string): Promise<Date | null>;
  /** Tenants that accepted, and how many usable tenants have not. */
  acceptanceSummary(documentId: string): Promise<
    Readonly<{
      accepted: readonly Readonly<{
        tenantId: string;
        tenantName: string;
        acceptedAt: Date;
        context: string;
      }>[];
      pending: number;
    }>
  >;
}
