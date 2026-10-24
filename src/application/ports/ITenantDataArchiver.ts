/** Everything a tenant stored, as one archive (docs/26 §6): CSV per table, its files, a README. */
export interface ITenantDataArchiver {
  build(
    tenantId: string,
    options: Readonly<{ businessName: string; generatedAt: Date }>,
  ): Promise<
    Readonly<{ zip: Uint8Array; tables: number; filesIncluded: number; filesSkipped: number }>
  >;
}
