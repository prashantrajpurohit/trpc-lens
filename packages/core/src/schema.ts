import { z } from "zod";

export const HttpInfoSchema = z.object({
  url: z.string(),
  method: z.string(),
  status: z.number().optional(),
  batchId: z.string().optional(),
  batchIndex: z.number().optional(),
  batchSize: z.number().optional(),
});

export type HttpInfo = z.infer<typeof HttpInfoSchema>;

export const InspectorEventSchema = z.object({
  /** Reused when a pending event is later updated with its result. */
  id: z.string(),
  projectId: z.string(),
  traceId: z.string().optional(),
  sessionId: z.string().optional(),
  timestamp: z.number(),
  path: z.string(),
  type: z.enum(["query", "mutation", "subscription"]),
  source: z.enum(["client", "server"]),
  status: z.enum(["pending", "success", "error"]),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  error: z
    .object({
      code: z.string().optional(),
      message: z.string(),
      issues: z.unknown().optional(),
      stack: z.string().optional(),
    })
    .optional(),
  /** Absent for direct server calls that have no HTTP request. */
  http: HttpInfoSchema.optional(),
  durationMs: z.number().optional(),
  truncated: z.boolean().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

export type InspectorEvent = z.infer<typeof InspectorEventSchema>;
