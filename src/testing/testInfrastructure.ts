import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";

/**
 * Where the integration tests get PostgreSQL, Mailpit and object storage (RustFS) from:
 * - `containers` (default): throw-away containers started by Testcontainers for this run only —
 *   nothing to start by hand, and development data is never touched. Needs Docker.
 * - `external`: services that are already running — the compose stack locally
 *   (`TEST_INFRA=external yarn test:integration`) or the service containers in CI.
 */
export type TestInfraMode = "containers" | "external";

/** Same images as compose.yaml and CI. */
const POSTGRES_IMAGE = "postgres:18-alpine";
const MAILPIT_IMAGE = "axllent/mailpit:v1.31.6";
const POSTGRES_PASSWORD = "autoforce_test_container_only";
const STORAGE_IMAGE = "rustfs/rustfs:1.0.1";
/** Same as the defaults of testConfig() (and compose.yaml). */
export const TEST_STORAGE_CREDENTIALS = Object.freeze({
  accessKeyId: "autoforce",
  secretAccessKey: "autoforce_local_only",
});

export function testInfraMode(env: NodeJS.ProcessEnv = process.env): TestInfraMode {
  const mode = env.TEST_INFRA ?? "containers";
  if (mode !== "containers" && mode !== "external") {
    throw new Error(`TEST_INFRA must be "containers" or "external", not "${mode}"`);
  }
  return mode;
}

export type StartedTestInfrastructure = Readonly<{
  /** Environment for the test workers: where PostgreSQL, SMTP and the Mailpit API are. */
  env: Readonly<Record<string, string>>;
  stop: () => Promise<void>;
}>;

export async function startTestInfrastructure(): Promise<StartedTestInfrastructure> {
  const started: StartedTestContainer[] = [];
  try {
    const postgres = await new GenericContainer(POSTGRES_IMAGE)
      .withEnvironment({ POSTGRES_USER: "autoforce", POSTGRES_PASSWORD })
      .withExposedPorts(5432)
      // Data on tmpfs: faster, and gone with the container.
      .withTmpFs({ "/var/lib/postgresql": "rw" })
      // The entrypoint restarts the server once after initialisation.
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .start();
    started.push(postgres);

    const mailpit = await new GenericContainer(MAILPIT_IMAGE)
      .withExposedPorts(1025, 8025)
      .withWaitStrategy(Wait.forHttp("/readyz", 8025))
      .start();
    started.push(mailpit);

    const storage = await new GenericContainer(STORAGE_IMAGE)
      .withEnvironment({
        RUSTFS_ACCESS_KEY: TEST_STORAGE_CREDENTIALS.accessKeyId,
        RUSTFS_SECRET_KEY: TEST_STORAGE_CREDENTIALS.secretAccessKey,
      })
      .withExposedPorts(9000)
      // RustFS runs as a non-root user: the tmpfs must be writable for it.
      .withTmpFs({ "/data": "rw,mode=1777" })
      .withWaitStrategy(Wait.forHttp("/health", 9000))
      .start();
    started.push(storage);

    return {
      env: {
        POSTGRES_HOST: postgres.getHost(),
        POSTGRES_PORT: String(postgres.getMappedPort(5432)),
        POSTGRES_USER: "autoforce",
        POSTGRES_PASSWORD,
        SMTP_HOST: mailpit.getHost(),
        SMTP_PORT: String(mailpit.getMappedPort(1025)),
        MAILPIT_URL: `http://${mailpit.getHost()}:${mailpit.getMappedPort(8025)}`,
        STORAGE_ENDPOINT: `http://${storage.getHost()}:${storage.getMappedPort(9000)}`,
      },
      stop: async () => {
        await Promise.allSettled(started.map((container) => container.stop()));
      },
    };
  } catch (error) {
    await Promise.allSettled(started.map((container) => container.stop()));
    throw error;
  }
}
