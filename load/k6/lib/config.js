// Shared settings for the k6 scripts. Override with environment variables:
//   BASE_URL  API origin (default http://localhost:3000; the Docker runner uses host.docker.internal)
//   PROFILE   smoke | load | stress (default smoke)
export const BASE_URL = (__ENV.BASE_URL || "http://localhost:3000").replace(/\/$/, "");

const PROFILES = {
  // A few requests to prove the script and the API work. Runs in seconds.
  smoke: [{ duration: "10s", target: 2 }],
  // Normal expected traffic, ramped up and held.
  load: [
    { duration: "30s", target: 20 },
    { duration: "2m", target: 20 },
    { duration: "15s", target: 0 },
  ],
  // Beyond expected traffic, to find where latency or errors start to climb.
  stress: [
    { duration: "30s", target: 50 },
    { duration: "1m", target: 100 },
    { duration: "1m", target: 200 },
    { duration: "30s", target: 0 },
  ],
};

export const PROFILE = __ENV.PROFILE || "smoke";

export function stages() {
  const selected = PROFILES[PROFILE];
  if (selected === undefined) {
    throw new Error(`Unknown PROFILE "${PROFILE}" (use ${Object.keys(PROFILES).join(", ")})`);
  }
  return selected;
}
