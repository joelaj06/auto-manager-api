import { describe, expect, it } from "vitest";
import { optChoice, parseWhatsAppWebhook } from "./WhatsAppWebhook.js";

const body = (value: unknown) => ({ entry: [{ changes: [{ value }] }] });

describe("parseWhatsAppWebhook", () => {
  it("reads statuses with when they happened", () => {
    const { statuses } = parseWhatsAppWebhook(
      body({ statuses: [{ id: "wamid.1", status: "read", timestamp: "1793000000" }] }),
    );
    expect(statuses).toEqual([
      {
        messageId: "wamid.1",
        status: "read",
        at: new Date(1_793_000_000_000),
        error: null,
        undeliverable: false,
      },
    ]);
  });

  it("tells a number that cannot get the message from other failures", () => {
    const { statuses } = parseWhatsAppWebhook(
      body({
        statuses: [
          {
            id: "a",
            status: "failed",
            timestamp: "1",
            errors: [{ code: 131026, title: "Message undeliverable" }],
          },
          { id: "b", status: "failed", timestamp: "1", errors: [{ code: 131000, title: "Oops" }] },
        ],
      }),
    );
    expect(statuses.map((s) => s.undeliverable)).toEqual([true, false]);
    expect(statuses[0]!.error).toBe("Message undeliverable (131026)");
  });

  it("gives replies with the number in E.164", () => {
    const { inbound } = parseWhatsAppWebhook(
      body({ messages: [{ from: "233241234567", text: { body: "STOP" } }] }),
    );
    expect(inbound).toEqual([{ from: "+233241234567", text: "STOP" }]);
  });

  it("passes over whatever it does not know", () => {
    expect(
      parseWhatsAppWebhook({
        entry: [
          "nonsense",
          {
            changes: [
              {
                value: {
                  statuses: [{ id: "x", status: "deleted", timestamp: "1" }],
                  messages: [{ from: "233", image: {} }],
                },
              },
            ],
          },
        ],
      }),
    ).toEqual({ statuses: [], inbound: [] });
  });
});

describe("optChoice", () => {
  it("reads only a plain request", () => {
    expect(optChoice(" Stop ")).toBe("out");
    expect(optChoice("START")).toBe("in");
    expect(optChoice("please stop by tomorrow")).toBeNull();
  });
});
