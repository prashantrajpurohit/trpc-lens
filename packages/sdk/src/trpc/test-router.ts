import { initTRPC, TRPCError, type TRPCMiddlewareFunction } from "@trpc/server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { z } from "zod";
import { sleep } from "../test-utils";

// Must not import "ws" or the bridge: middleware.gate.test.ts spies on ws being loaded.

export interface Ctx {
  req?: Request;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMiddleware = TRPCMiddlewareFunction<any, any, object, object, unknown>;

/**
 * The same procedures with and without the middleware, so every result can be
 * compared with a control. Pass no middleware for the control.
 */
export function buildRouter(middleware?: AnyMiddleware) {
  const t = initTRPC.context<Ctx>().create();
  const base = middleware ? t.procedure.use(t.middleware(middleware)) : t.procedure;
  // Validation first, middleware second: it must still see the raw input.
  const inputFirst = t.procedure.input(z.object({ n: z.string().transform(Number) }));

  const router = t.router({
    echo: base
      .input(z.object({ n: z.number(), s: z.string(), ms: z.number().optional() }))
      .query(async ({ input }) => {
        if (input.ms) await sleep(input.ms);
        return { doubled: input.n * 2, upper: input.s.toUpperCase() };
      }),
    add: base
      .input(z.object({ a: z.number(), b: z.number() }))
      .mutation(({ input }) => ({ sum: input.a + input.b })),
    missing: base.input(z.object({ id: z.string() })).query(({ input }) => {
      throw new TRPCError({ code: "NOT_FOUND", message: `user "${input.id}" not found` });
    }),
    slow: base.query(async () => {
      await sleep(60);
      return { done: true };
    }),
    coerce: base.input(z.object({ n: z.string().transform(Number) })).query(({ input }) => input),
    coerceAfterInput: (middleware ? inputFirst.use(t.middleware(middleware)) : inputFirst).query(
      ({ input }) => input,
    ),
    ticks: base.subscription(async function* () {
      yield 1;
    }),
    brokenTicks: base.subscription(() => {
      throw new TRPCError({ code: "FORBIDDEN", message: "no stream" });
    }),
  });

  return { router, createCaller: t.createCallerFactory(router) };
}

export type TestRouter = ReturnType<typeof buildRouter>["router"];

/** One non-batched request through the fetch adapter; `req` is put in context. */
export async function fetchCall(
  router: TestRouter,
  path: string,
  input: unknown,
  method: "GET" | "POST" = "GET",
): Promise<{ status: number; body: unknown }> {
  const base = `http://localhost/api/trpc/${path}`;
  const req =
    method === "GET"
      ? new Request(`${base}?input=${encodeURIComponent(JSON.stringify(input))}`)
      : new Request(base, { method: "POST", body: JSON.stringify(input), headers: { "content-type": "application/json" } });
  const res = await fetchRequestHandler({ endpoint: "/api/trpc", req, router, createContext: ({ req }) => ({ req }) });
  return { status: res.status, body: await res.json() };
}

/** The settled outcome of a call, comparable across routers. */
export async function outcome(promise: Promise<unknown>): Promise<unknown> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    const e = error as TRPCError;
    return { ok: false, name: e.name, code: e.code, message: e.message, cause: e.cause?.constructor?.name };
  }
}
