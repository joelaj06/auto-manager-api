import type { LookupAddress, LookupOptions } from "node:dns";
import { lookup as dnsLookup } from "node:dns";
import https from "node:https";
import { BlockList, isIP } from "node:net";
import type { IWebhookTransport, WebhookResponse } from "../../application/ports/IWebhooks.js";

const TIMEOUT_MS = 10_000;

const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  blocked.addSubnet(address, prefix, "ipv6");

/** Whether an address is outside the public internet, IPv4-mapped IPv6 included. */
export function isPrivateAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped !== undefined) return blocked.check(mapped, "ipv4");
  const family = isIP(address);
  if (family === 0) return true;
  return blocked.check(address, family === 4 ? "ipv4" : "ipv6");
}

type Resolve = (
  hostname: string,
  callback: (error: Error | null, addresses: LookupAddress[]) => void,
) => void;

const resolveAll: Resolve = (hostname, callback) => {
  dnsLookup(hostname, { all: true }, (error, addresses) => callback(error, addresses));
};

/**
 * The name lookup a connection uses, refusing private addresses. Checking here, not before the
 * request, leaves no gap for a name that changes its answer between the check and the call.
 */
export function publicOnlyLookup(resolve: Resolve = resolveAll) {
  return (
    hostname: string,
    options: LookupOptions,
    callback: (
      error: NodeJS.ErrnoException | null,
      address: string | LookupAddress[],
      family?: number,
    ) => void,
  ): void => {
    resolve(hostname, (error, addresses) => {
      if (error !== null) return callback(error, "");
      const first = addresses[0];
      if (first === undefined) return callback(new Error(`No address for ${hostname}`), "");
      if (addresses.some((a) => isPrivateAddress(a.address)))
        return callback(new Error(`${hostname} is not a public address`), "");
      if (options.all === true) return callback(null, addresses);
      return callback(null, first.address, first.family);
    });
  };
}

/** Posts one webhook. Redirects are not followed: an address that moves is an address to fix. */
export class HttpsWebhookTransport implements IWebhookTransport {
  post(
    url: string,
    headers: Readonly<Record<string, string>>,
    body: string,
  ): Promise<WebhookResponse> {
    return new Promise((resolve) => {
      let target: URL;
      try {
        target = new URL(url);
      } catch {
        resolve({ status: null, error: "Not a web address" });
        return;
      }
      if (target.protocol !== "https:") {
        resolve({ status: null, error: "Only https addresses are called" });
        return;
      }
      if (isIP(target.hostname.replace(/^\[|\]$/g, "")) !== 0) {
        resolve({ status: null, error: "Only host names are called" });
        return;
      }
      const request = https.request(
        target,
        {
          method: "POST",
          agent: false,
          timeout: TIMEOUT_MS,
          lookup: publicOnlyLookup(),
          headers: { ...headers, "Content-Length": Buffer.byteLength(body).toString() },
        },
        (response) => {
          // The answer's content is not ours to keep; only its status counts.
          response.resume();
          response.on("end", () => resolve({ status: response.statusCode ?? null, error: null }));
          response.on("error", () =>
            resolve({ status: response.statusCode ?? null, error: "The answer was cut off" }),
          );
        },
      );
      request.on("timeout", () => request.destroy(new Error("No answer within 10 seconds")));
      request.on("error", (error) => resolve({ status: null, error: error.message }));
      request.end(body);
    });
  }
}
