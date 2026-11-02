import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { createTRPCRouter, publicProcedure } from "../trpc";

let nextId = 100;

export const postRouter = createTRPCRouter({
  create: publicProcedure
    .input(
      z.object({
        title: z.string().min(1),
        email: z.email(),
        password: z.string().min(8),
      }),
    )
    .mutation(() => ({ ok: true as const, id: nextId++ })),

  findMissing: publicProcedure.query(() => {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `No post by jane.fake@example.test titled "Quarterly Fake Report"`,
    });
  }),
});
