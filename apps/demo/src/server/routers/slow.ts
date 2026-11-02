import { createTRPCRouter, publicProcedure } from "../trpc";

export const slowRouter = createTRPCRouter({
  compute: publicProcedure.query(async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    return { result: 42 };
  }),
});
