import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { ReceiptReaderError } from "../../application/ports/IReceiptReader.js";
import { ClaudeReceiptReader } from "./ClaudeReceiptReader.js";

const clock = { now: () => new Date("2026-11-03T10:00:00Z") };
const png = { bytes: new Uint8Array([1, 2, 3]), contentType: "image/png" as const };
const answer = {
  merchant: "Star Oil",
  date: "2026-11-01",
  total: "300.00",
  tax: null,
  currency: "GHS",
  isReceipt: true,
  confidence: "high",
};

function reader(response: unknown) {
  const requests: Record<string, unknown>[] = [];
  const client = {
    beta: {
      messages: {
        parse: (params: Record<string, unknown>) => {
          requests.push(params);
          return Promise.resolve(response);
        },
      },
    },
  };
  return {
    requests,
    reader: new ClaudeReceiptReader(
      "key",
      "claude-opus-5-5",
      clock,
      client as unknown as Anthropic,
    ),
  };
}

const response = (over: object = {}) => ({
  stop_reason: "end_turn",
  parsed_output: answer,
  model: "claude-opus-5-5",
  usage: { input_tokens: 900, output_tokens: 80 },
  ...over,
});

describe("ClaudeReceiptReader", () => {
  it("returns the figures with what they cost", async () => {
    const { reader: r } = reader(response());
    await expect(r.read(png)).resolves.toMatchObject({
      merchant: "Star Oil",
      total: "300.00",
      inputTokens: 900,
      outputTokens: 80,
    });
  });

  it("drops what cannot stand as a figure", async () => {
    const { reader: r } = reader(
      response({ parsed_output: { ...answer, date: "2027-01-01", total: "free" } }),
    );
    await expect(r.read(png)).resolves.toMatchObject({ date: null, total: null });
  });

  it("sends a PDF as a document and a photo as an image, without tools", async () => {
    const { reader: r, requests } = reader(response());
    await r.read({ ...png, contentType: "application/pdf" });
    await r.read(png);
    const first = (m: Record<string, unknown>) =>
      (m.messages as { content: { type: string }[] }[])[0]!.content[0]!.type;
    expect(requests.map(first)).toEqual(["document", "image"]);
    expect(requests[0]).not.toHaveProperty("tools");
  });

  it("fails for good on a refusal or no answer", async () => {
    for (const bad of [{ stop_reason: "refusal" }, { parsed_output: null }]) {
      const { reader: r } = reader(response(bad));
      const failure = await r.read(png).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(ReceiptReaderError);
      expect((failure as ReceiptReaderError).permanent).toBe(true);
    }
  });
});
