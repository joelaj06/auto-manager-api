// The tenant API under load with a signed-in user (seed one with `yarn load:seed`): the reads a
// back office makes all day — vehicles, drivers, payments, the ledger, dashboards, the work and
// pay portfolio, notifications — and money in (one request in ten records a payment, which posts
// a journal entry and takes numbers). Needs TENANT, EMAIL and PASSWORD, and an API started with a
// high RATE_LIMIT_MAX (the per-IP limit otherwise answers 429).
import http from "k6/http";
import { check, fail, sleep } from "k6";
import { BASE_URL, stages } from "./lib/config.js";

export const options = {
  stages: stages(),
  thresholds: {
    http_req_failed: ["rate<0.01"],
    "http_req_duration{kind:read}": ["p(95)<300"],
    "http_req_duration{kind:write}": ["p(95)<500"],
    checks: ["rate>0.99"],
  },
};

const READS = [
  "/api/v1/vehicles?limit=30",
  "/api/v1/drivers?limit=30",
  "/api/v1/payments?limit=30",
  "/api/v1/ledger/trial-balance",
  "/api/v1/dashboards/overview",
  "/api/v1/dashboards/workpay",
  "/api/v1/workpay/agreements?limit=30",
  "/api/v1/notifications/unread-count",
];

export function setup() {
  for (const name of ["TENANT", "EMAIL", "PASSWORD"])
    if (!__ENV[name]) fail(`${name} is required (yarn load:seed prints them)`);
  const login = http.post(
    `${BASE_URL}/api/v1/auth/login`,
    JSON.stringify({ identifier: __ENV.EMAIL, password: __ENV.PASSWORD }),
    { headers: { "Content-Type": "application/json", "X-Tenant": __ENV.TENANT } },
  );
  if (login.status !== 200) fail(`login failed: ${login.status} ${login.body}`);
  const token = login.json("data.accessToken");
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const customers = http.get(`${BASE_URL}/api/v1/customers?limit=20`, { headers });
  return { headers, customers: customers.json("data").map((c) => c.id) };
}

export default function (data) {
  const params = { headers: data.headers, tags: { kind: "read" } };
  const path = READS[Math.floor(Math.random() * READS.length)];
  const res = http.get(`${BASE_URL}${path}`, { ...params, tags: { kind: "read", name: path } });
  check(res, { "read: 200": (r) => r.status === 200 });

  if (Math.random() < 0.1 && data.customers.length > 0) {
    const paid = http.post(
      `${BASE_URL}/api/v1/payments`,
      JSON.stringify({
        direction: "in",
        partyType: "customer",
        partyId: data.customers[Math.floor(Math.random() * data.customers.length)],
        amount: "25.00",
        method: "momo",
        momoNetwork: "mtn",
        reference: `K6-${Date.now()}-${__VU}-${__ITER}`,
      }),
      { headers: data.headers, tags: { kind: "write", name: "POST /payments" } },
    );
    check(paid, { "write: 201": (r) => r.status === 201 });
  }
  sleep(0.2);
}
