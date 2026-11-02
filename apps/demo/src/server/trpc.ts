import { inspectorMiddleware } from "@prashant-rajpurohit/trpc-inspector-sdk/trpc";
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { z, ZodError } from "zod";
import type { Context } from "./context";

const t = initTRPC.context<Context>().create({
  transformer: superjson,
  errorFormatter({ shape, error }) {
    return {
      ...shape,
      data: {
        ...shape.data,
        zodError: error.cause instanceof ZodError ? z.flattenError(error.cause) : null,
        errorCode: error.code,
      },
    };
  },
});

export const createTRPCRouter = t.router;
export const createCallerFactory = t.createCallerFactory;

// The inspector must come first so it sees every call, including auth rejections.
const baseProcedure = t.procedure.use(t.middleware(inspectorMiddleware()));

export const publicProcedure = baseProcedure;

export const privateProcedure = baseProcedure.use(({ ctx, next }) => {
  if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED", message: "Sign in to view your profile" });
  return next({ ctx: { ...ctx, user: ctx.user } });
});
