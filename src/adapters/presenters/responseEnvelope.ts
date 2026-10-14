import { z } from "zod";

/** Success envelope used by every endpoint: `{ data }` or `{ data, meta }`. */
export function envelope<T>(data: T, meta?: Readonly<Record<string, unknown>>) {
  return meta === undefined ? { data } : { data, meta };
}

/** Schema of the error envelope, for API documentation. */
export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string().describe("Stable machine-readable error code"),
    message: z.string(),
    details: z.array(z.object({ field: z.string(), message: z.string() })).optional(),
    requestId: z.string().optional(),
  }),
});

export const dataEnvelope = <T extends z.ZodType>(data: T) => z.object({ data });
