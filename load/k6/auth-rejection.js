// Cost of rejecting bad credentials: every request carries an invalid bearer token and must get a
// fast 401 without touching a tenant database. Protects against credential-stuffing load.
//
// /api is rate-limited per client IP (RATE_LIMIT_MAX per RATE_LIMIT_WINDOW_MS). Start the API with
// a high RATE_LIMIT_MAX for this test, otherwise most requests are answered 429.
import http from "k6/http";
import { check } from "k6";
import encoding from "k6/encoding";
import { BASE_URL, stages } from "./lib/config.js";

export const options = {
  stages: stages(),
  thresholds: {
    // 401 is the expected answer here, so it is not counted as a failed request.
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<100"],
    checks: ["rate>0.99"],
  },
};

http.setResponseCallback(http.expectedStatuses(401));

const b64 = (value) => encoding.b64encode(JSON.stringify(value), "rawurl");
// Well-formed JWT shape with a tenant claim but a wrong signature: exercises key derivation and
// signature verification, the most expensive rejection path.
const forged = [
  b64({ alg: "HS256", typ: "at+jwt" }),
  b64({ tid: "0198f0e0-0000-7000-8000-00000000000a", sub: "u", sid: "s", ver: 1 }),
  "c2lnbmF0dXJl",
].join(".");

const TOKENS = ["garbage", forged];

export default function () {
  const token = TOKENS[__ITER % TOKENS.length];
  const res = http.get(`${BASE_URL}/api/v1/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  check(res, { "rejected with 401": (r) => r.status === 401 });
}
