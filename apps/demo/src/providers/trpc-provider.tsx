"use client";

import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { httpBatchLink, type TRPCLink } from "@trpc/client";
import { useState, type ReactNode } from "react";
import superjson from "superjson";
import { trpc } from "@/lib/trpc/client";
import { makeQueryClient } from "@/lib/trpc/query-client";
import type { AppRouter } from "@/server/routers/_app";

let browserQueryClient: QueryClient | undefined;

function getQueryClient() {
  // Server render: always a fresh client. Browser: one for the page's lifetime.
  if (typeof window === "undefined") return makeQueryClient();
  return (browserQueryClient ??= makeQueryClient());
}

/** Stand-in for the real project's custom link; forwards every operation unchanged. */
const passThroughLink: TRPCLink<AppRouter> =
  () =>
  ({ op, next }) =>
    next(op);

export function TRPCProvider({ children }: { children: ReactNode }) {
  const queryClient = getQueryClient();
  const [trpcClient] = useState(() =>
    trpc.createClient({
      links: [passThroughLink, httpBatchLink({ url: "/api/trpc", transformer: superjson })],
    }),
  );

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
}
