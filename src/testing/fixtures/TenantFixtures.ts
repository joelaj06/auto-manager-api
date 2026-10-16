import { randomUUID } from "node:crypto";
import type { Container } from "inversify";
import type pg from "pg";
import type { IAccessTokenService } from "../../application/ports/IAccessTokenService.js";
import type { ITenantContext } from "../../application/ports/ITenantContext.js";
import type { ITenantDatabaseProvisioner } from "../../application/ports/ITenantDatabaseProvisioner.js";
import type { TenantStatus } from "../../application/ports/ITenantDirectory.js";
import type { IUnitOfWork } from "../../application/ports/IUnitOfWork.js";
import { TenantId } from "../../domain/value-objects/TenantId.js";
import { TYPES } from "../../framework/dependency-injection/types.js";
import type { PostgresTransactionContext } from "../../infrastructure/database/postgres/PostgresTransactionContext.js";

export type TenantFixtureOptions = Readonly<{
  status?: TenantStatus;
  timezone?: string;
  slug?: string;
  name?: string;
}>;

/**
 * A real tenant for integration tests: its own database cloned from the test template and a row
 * in the platform `tenants` table, with helpers to work inside it as the application would.
 */
export class TestTenant {
  constructor(
    readonly id: TenantId,
    readonly slug: string,
    private readonly container: Container,
  ) {}

  /** Runs `work` as this tenant, inside one unit of work (one transaction on its database). */
  run<T>(work: () => Promise<T>): Promise<T> {
    const tenantContext = this.container.get<ITenantContext>(TYPES.TenantContext);
    const unitOfWork = this.container.get<IUnitOfWork>(TYPES.UnitOfWork);
    return tenantContext.runAs(this.id, () => unitOfWork.run(work));
  }

  /** Runs SQL in this tenant's database as the tenant app role. */
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(sql: string, params: unknown[] = []) {
    const tx = this.container.get<PostgresTransactionContext>(TYPES.PostgresTransactionContext);
    return this.run(async () => (await tx.current().query<R>(sql, params)).rows);
  }

  /** A valid access token for a user of this tenant. */
  async accessToken(userId: string = randomUUID(), permissionVersion = 1): Promise<string> {
    const tokens = this.container.get<IAccessTokenService>(TYPES.AccessTokenService);
    const { token } = await tokens.issue({
      audience: "tenant",
      tenantId: this.id.value,
      userId,
      sessionId: randomUUID(),
      permissionVersion,
    });
    return token;
  }

  async setStatus(status: TenantStatus): Promise<void> {
    await this.platform().query("update tenants set status = $2 where id = $1", [
      this.id.value,
      status,
    ]);
  }

  private platform(): pg.Pool {
    return this.container.get<pg.Pool>(TYPES.PlatformDatabasePool);
  }
}

/** Creates test tenants through the same provisioner the application uses. */
export class TenantFixtures {
  constructor(private readonly container: Container) {}

  async create(options: TenantFixtureOptions = {}): Promise<TestTenant> {
    const id = TenantId.from(randomUUID());
    const slug = options.slug ?? `t-${id.value.slice(0, 8)}-${id.value.slice(-4)}`;
    await this.container
      .get<ITenantDatabaseProvisioner>(TYPES.TenantDatabaseProvisioner)
      .provision(id);
    await this.container.get<pg.Pool>(TYPES.PlatformDatabasePool).query(
      `insert into tenants (id, slug, name, status, timezone)
         values ($1, $2, $3, $4, $5)`,
      [
        id.value,
        slug,
        options.name ?? `Test business ${slug}`,
        options.status ?? "active",
        options.timezone ?? "Africa/Accra",
      ],
    );
    return new TestTenant(id, slug, this.container);
  }

  /** Two active tenants, for isolation tests. */
  async pair(): Promise<readonly [TestTenant, TestTenant]> {
    return [await this.create(), await this.create()];
  }
}
