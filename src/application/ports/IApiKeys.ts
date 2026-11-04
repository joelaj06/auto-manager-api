export type ApiKeyRecord = Readonly<{
  id: string;
  name: string;
  hint: string;
  scopes: readonly string[];
  createdBy: string;
  createdByName: string | null;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  requests: number;
  revokedAt: Date | null;
  createdAt: Date;
}>;

export type NewApiKey = Readonly<{
  name: string;
  keyHash: string;
  hint: string;
  scopes: readonly string[];
  createdBy: string;
  expiresAt: Date | null;
}>;

export type UsableApiKey = Readonly<{
  id: string;
  name: string;
  userId: string;
  scopes: readonly string[];
}>;

/** A business's API keys, kept only as hashes (decisions 523–524). */
export interface IApiKeys {
  create(key: NewApiKey): Promise<string>;
  find(id: string): Promise<ApiKeyRecord | null>;
  list(includeRevoked: boolean): Promise<ApiKeyRecord[]>;
  countLive(now: Date): Promise<number>;
  /**
   * The key with this hash if it is live and its user active, counting this use. One statement,
   * so every request is counted without a second round trip.
   */
  use(keyHash: string, now: Date): Promise<UsableApiKey | null>;
  revoke(id: string, revokedBy: string | null, now: Date): Promise<boolean>;
}
