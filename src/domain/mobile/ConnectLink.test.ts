import { describe, expect, it } from "vitest";
import type { ConnectLinkError } from "./ConnectLink.js";
import {
  connectQuery,
  connectSigningMessage,
  HostAllowList,
  parseConnectLink,
  type ConnectPayload,
} from "./ConnectLink.js";

const payload: ConnectPayload = {
  version: 1,
  apiBaseUrl: "https://api.autoforce.example/",
  tenantSlug: "acme-fleet",
  keyId: "k-1a2b3c4d",
};
const sig = "s".repeat(86);

describe("connect links", () => {
  it("round-trips through the https link and the custom scheme", () => {
    const query = connectQuery(payload, sig);
    for (const link of [
      `https://link.autoforce.example/connect?${query}`,
      `autoforce://connect?${query}`,
    ]) {
      expect(parseConnectLink(link, "autoforce")).toEqual({ payload, signature: sig });
    }
    const invite = { ...payload, invitationToken: "a".repeat(43), expiresAt: 1_800_000_000 };
    expect(
      parseConnectLink(`autoforce://connect?${connectQuery(invite, sig)}`, "autoforce").payload,
    ).toEqual(invite);
  });

  it("signs a fixed, line-based message", () => {
    expect(connectSigningMessage(payload)).toBe(
      "autoforce-connect\nv=1\napi=https://api.autoforce.example/\nt=acme-fleet\ninv=\nexp=\nk=k-1a2b3c4d",
    );
  });

  it("refuses links of another shape or version", () => {
    const reasonOf = (link: string) => {
      try {
        parseConnectLink(link, "autoforce");
      } catch (error) {
        return (error as ConnectLinkError).reason;
      }
      return "valid";
    };
    expect(reasonOf("not a url")).toBe("malformed");
    expect(reasonOf(`https://x.example/other?${connectQuery(payload, sig)}`)).toBe("malformed");
    expect(reasonOf(`ftp://x.example/connect?${connectQuery(payload, sig)}`)).toBe("malformed");
    expect(reasonOf(`autoforce://connect?${connectQuery({ ...payload, version: 2 }, sig)}`)).toBe(
      "unsupported_version",
    );
    expect(
      reasonOf(`autoforce://connect?${connectQuery({ ...payload, tenantSlug: "Bad Slug" }, sig)}`),
    ).toBe("malformed");
    expect(
      reasonOf(
        `autoforce://connect?${connectQuery({ ...payload, apiBaseUrl: "https://evil.example/path" }, sig)}`,
      ),
    ).toBe("malformed");
  });
});

describe("HostAllowList", () => {
  const list = new HostAllowList(["api.autoforce.example", "*.autoforce.app", "localhost:3000"]);

  it("allows exact hosts and one-level wildcards only", () => {
    expect(list.allows("api.autoforce.example")).toBe(true);
    expect(list.allows("API.AUTOFORCE.EXAMPLE")).toBe(true);
    expect(list.allows("acme.autoforce.app")).toBe(true);
    expect(list.allows("localhost:3000")).toBe(true);
    expect(list.allows("autoforce.app")).toBe(false);
    expect(list.allows("a.b.autoforce.app")).toBe(false);
    expect(list.allows("evilautoforce.app")).toBe(false);
    expect(list.allows("api.autoforce.example.evil.com")).toBe(false);
    expect(list.allows("localhost:4000")).toBe(false);
    expect(list.allowsUrl("https://acme.autoforce.app/")).toBe(true);
    expect(list.allowsUrl("nonsense")).toBe(false);
  });
});
