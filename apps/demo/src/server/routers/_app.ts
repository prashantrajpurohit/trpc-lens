import { createTRPCRouter } from "../trpc";
import { bigPayloadRouter } from "./big-payload";
import { meRouter } from "./me";
import { postRouter } from "./post";
import { slowRouter } from "./slow";
import { userRouter } from "./user";

export const appRouter = createTRPCRouter({
  user: userRouter,
  post: postRouter,
  me: meRouter,
  slow: slowRouter,
  bigPayload: bigPayloadRouter,
});

export type AppRouter = typeof appRouter;
