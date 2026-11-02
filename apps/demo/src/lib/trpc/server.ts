import { createHydrationHelpers } from "@trpc/react-query/rsc";
import { cache } from "react";
import { createTRPCContext } from "@/server/context";
import { appRouter, type AppRouter } from "@/server/routers/_app";
import { createCallerFactory } from "@/server/trpc";
import { makeQueryClient } from "./query-client";

// One QueryClient per request.
export const getQueryClient = cache(makeQueryClient);

const caller = createCallerFactory(appRouter)(createTRPCContext);

export const { trpc, HydrateClient } = createHydrationHelpers<AppRouter>(caller, getQueryClient);
