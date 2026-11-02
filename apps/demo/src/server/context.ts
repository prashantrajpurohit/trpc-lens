import { cookies } from "next/headers";
import { cache } from "react";

export interface SessionUser {
  id: number;
  name: string;
}

// Fake sessions; the `demo-user` cookie holds one of these keys.
const SESSIONS: Record<string, SessionUser> = {
  ada: { id: 1, name: "Ada Demo" },
  bob: { id: 2, name: "Bob Sample" },
};

/** One context per request, shared by Server Components and the HTTP handler. */
export const createTRPCContext = cache(async () => {
  const cookieStore = await cookies();
  const key = cookieStore.get("demo-user")?.value;
  return { user: key ? (SESSIONS[key] ?? null) : null };
});

export type Context = Awaited<ReturnType<typeof createTRPCContext>>;
