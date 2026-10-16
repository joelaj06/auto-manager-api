import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";

/**
 * Where the integration tests get PostgreSQL and Mailpit from:
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

    return {
      env: {
        POSTGRES_HOST: postgres.getHost(),
        POSTGRES_PORT: String(postgres.getMappedPort(5432)),
        POSTGRES_USER: "autoforce",
        POSTGRES_PASSWORD,
        SMTP_HOST: mailpit.getHost(),
        SMTP_PORT: String(mailpit.getMappedPort(1025)),
        MAILPIT_URL: `http://${mailpit.getHost()}:${mailpit.getMappedPort(8025)}`,
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
