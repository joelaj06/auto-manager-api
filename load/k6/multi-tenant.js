// Many tenants at once (seed them with `yarn load:seed --tenants 100 …`): each iteration picks a
// tenant at random and makes the reads a back office makes, one in ten a payment. What it tests
// beyond tenant-api.js: one database per tenant — the pool manager opening, reusing and evicting
// tenant pools while traffic is spread over many databases (docs/22 §2). Needs
// load/k6/data/tenants.json and an API started with high RATE_LIMIT_MAX and AUTH_RATE_LIMIT_MAX.
import http from "k6/http";
import { check, fail, sleep } from "k6";
import { BASE_URL, stages } from "./lib/config.js";

const TENANTS = JSON.parse(open("./data/tenants.json"));

export const options = {
  stages: stages(),
  setupTimeout: "10m",
  thresholds: {
    http_req_failed: ["rate<0.01"],
    "http_req_duration{kind:read}": ["p(95)<400"],
    "http_req_duration{kind:write}": ["p(95)<600"],
    checks: ["rate>0.99"],
  },
};

const READS = [
  "/api/v1/vehicles?limit=30",
  "/api/v1/drivers?limit=30",
  "/api/v1/payments?limit=30",
  "/api/v1/ledger/trial-balance",
  "/api/v1/dashboards/overview",
  "/api/v1/notifications/unread-count",
  "/api/v1/billing/subscription",
  "/api/v1/announcements",
];

export function setup() {
  if (TENANTS.length === 0) fail("load/k6/data/tenants.json has no tenants");
  return TENANTS.map((t) => {
    const login = http.post(
      `${BASE_URL}/api/v1/auth/login`,
      JSON.stringify({ identifier: t.email, password: t.password }),
      { headers: { "Content-Type": "application/json", "X-Tenant": t.tenant } },
    );
    if (login.status !== 200) fail(`login to ${t.tenant} failed: ${login.status} ${login.body}`);
    const headers = {
      Authorization: `Bearer ${login.json("data.accessToken")}`,
      "Content-Type": "application/json",
    };
    const customers = http.get(`${BASE_URL}/api/v1/customers?limit=20`, { headers });
    return { headers, customers: customers.json("data").map((c) => c.id) };
  });
}

export default function (tenants) {
  const t = tenants[Math.floor(Math.random() * tenants.length)];
  const path = READS[Math.floor(Math.random() * READS.length)];
  const res = http.get(`${BASE_URL}${path}`, {
    headers: t.headers,
    tags: { kind: "read", name: path },
  });
  check(res, { "read: 200": (r) => r.status === 200 });

  if (Math.random() < 0.1 && t.customers.length > 0) {
    const paid = http.post(
      `${BASE_URL}/api/v1/payments`,
      JSON.stringify({
        direction: "in",
        partyType: "customer",
        partyId: t.customers[Math.floor(Math.random() * t.customers.length)],
        amount: "25.00",
        method: "momo",
        momoNetwork: "mtn",
        reference: `K6-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
      }),
      { headers: t.headers, tags: { kind: "write", name: "/api/v1/payments" } },
    );
    check(paid, { "payment: 201": (r) => r.status === 201 });
  }
  sleep(0.2);
}
