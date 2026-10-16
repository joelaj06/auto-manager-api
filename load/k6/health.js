// Health probes under load: liveness must stay trivial, readiness includes a database round trip.
// Health endpoints are not rate-limited, so this measures the HTTP stack and the platform pool.
import http from "k6/http";
import { check, sleep } from "k6";
import { BASE_URL, stages } from "./lib/config.js";

export const options = {
  stages: stages(),
  thresholds: {
    http_req_failed: ["rate<0.01"],
    "http_req_duration{probe:live}": ["p(95)<50"],
    "http_req_duration{probe:ready}": ["p(95)<250"],
    checks: ["rate>0.99"],
  },
};

export default function () {
  const live = http.get(`${BASE_URL}/health/live`, { tags: { probe: "live" } });
  check(live, { "live: 200": (r) => r.status === 200 });

  const ready = http.get(`${BASE_URL}/health/ready`, { tags: { probe: "ready" } });
  check(ready, {
    "ready: 200": (r) => r.status === 200,
    "ready: database up": (r) => r.json("data.checks.0.status") === "up",
  });
  sleep(0.1);
}
