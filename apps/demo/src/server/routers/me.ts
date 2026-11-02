import { createTRPCRouter, privateProcedure } from "../trpc";

export const meRouter = createTRPCRouter({
  profile: privateProcedure.query(({ ctx }) => ({ id: ctx.user.id, name: ctx.user.name, plan: "demo" })),
});
