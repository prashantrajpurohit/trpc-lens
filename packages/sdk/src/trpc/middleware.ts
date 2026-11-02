import type { InspectorEvent } from "@prashant-rajpurohit/trpc-inspector-core";
// Types only: this module must not load @trpc/server at runtime.
import type { TRPCMiddlewareFunction } from "@trpc/server";
import { emitEvent, isEnabled, newId } from "../sdk";

export interface HttpInfo {
  url: string;
  method: string;
}

export interface InspectorMiddlewareOptions<TContext = any> {
  /**
   * Request URL and method for an event. Default: `ctx.req.url` and
   * `ctx.req.method` when both are strings (fetch `Request` or Node
   * `IncomingMessage`), otherwise undefined. Headers, cookies and the body are
   * never read.
   */
  getHttpInfo?: (ctx: TContext) => HttpInfo | undefined;
}

type ErrorInfo = NonNullable<InspectorEvent["error"]>;

function isObject(value: unknown): value is Record<string, unknown> {
  return (typeof value === "object" || typeof value === "function") && value !== null;
}

function defaultHttpInfo(ctx: unknown): HttpInfo | undefined {
  if (!isObject(ctx) || !isObject(ctx.req)) return undefined;
  const { url, method } = ctx.req;
  return typeof url === "string" && typeof method === "string" ? { url, method } : undefined;
}

/** Duck-typed so no TRPCError class is needed at runtime. */
function errorInfo(error: unknown): ErrorInfo {
  const e = isObject(error) ? error : {};
  const info: ErrorInfo = { message: typeof e.message === "string" ? e.message : "Unknown error" };
  if (typeof e.code === "string") info.code = e.code;
  // Validation errors (zod, Standard Schema) carry their issues on the cause.
  if (isObject(e.cause) && Array.isArray(e.cause.issues)) info.issues = e.cause.issues;
  if (typeof e.stack === "string") info.stack = e.stack;
  return info;
}

/**
 * Captures every execution of the procedures it is attached to, including
 * direct server calls that never touch HTTP:
 *
 *     const publicProcedure = t.procedure.use(t.middleware(inspectorMiddleware()));
 *
 * Subscriptions record their start, and an error if setup fails; individual
 * stream messages are not captured.
 */
export function inspectorMiddleware<TContext = any>(
  options: InspectorMiddlewareOptions<TContext> = {},
): TRPCMiddlewareFunction<TContext, any, object, object, unknown> {
  const getHttpInfo = options.getHttpInfo ?? defaultHttpInfo;

  return async function inspectorMiddleware(opts) {
    const { next } = opts;
    if (!isEnabled()) return next();

    // Everything below is per call; nothing is shared between concurrent calls.
    let base: InspectorEvent | undefined;
    let start = 0;
    try {
      start = performance.now();
      base = {
        id: newId(),
        // Replaced by the configured project id when sanitized.
        projectId: "",
        timestamp: Date.now(),
        path: opts.path,
        type: opts.type,
        source: "server",
        status: "pending",
      };
      try {
        base.input = await opts.getRawInput();
      } catch {
        // Unreadable input is omitted; the procedure reports its own error.
      }
      try {
        const http = getHttpInfo(opts.ctx as TContext);
        if (http && typeof http.url === "string" && typeof http.method === "string") {
          base.http = { url: http.url, method: http.method };
        }
      } catch {
        // No HTTP info rather than no event.
      }
      emitEvent(base);
    } catch {
      base = undefined;
    }

    const finish = (final: Partial<InspectorEvent>) => {
      try {
        if (base) emitEvent({ ...base, ...final, durationMs: performance.now() - start });
      } catch {
        // Never affect the procedure's outcome.
      }
    };

    let result: Awaited<ReturnType<typeof next>>;
    try {
      result = await next();
    } catch (error) {
      finish({ status: "error", error: errorInfo(error) });
      throw error;
    }

    try {
      if (result.ok) {
        // A subscription's data is its stream; its messages are not captured.
        if (base?.type !== "subscription") finish({ status: "success", output: result.data });
      } else {
        finish({ status: "error", error: errorInfo(result.error) });
      }
    } catch {
      // Never affect the procedure's outcome.
    }
    return result;
  };
}
