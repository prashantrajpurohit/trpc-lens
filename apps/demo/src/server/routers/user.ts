import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { createTRPCRouter, publicProcedure } from "../trpc";

const USERS = [
  { id: 1, name: "Ada Demo", email: "ada@example.test", role: "admin", createdAt: new Date("2024-01-15T10:00:00Z") },
  { id: 2, name: "Bob Sample", email: "bob@example.test", role: "editor", createdAt: new Date("2024-03-02T08:30:00Z") },
  { id: 3, name: "Cy Fixture", email: "cy@example.test", role: "viewer", createdAt: new Date("2024-06-20T17:45:00Z") },
];

export const userRouter = createTRPCRouter({
  getById: publicProcedure.input(z.object({ id: z.number() })).query(({ input }) => {
    const user = USERS.find((u) => u.id === input.id);
    if (!user) throw new TRPCError({ code: "NOT_FOUND", message: `No user with id ${input.id}` });
    return user;
  }),

  list: publicProcedure.query(() => ({
    users: USERS,
    rolesById: new Map(USERS.map((u) => [u.id, u.role])),
    tags: new Set(["alpha", "beta", "gamma"]),
  })),
});
