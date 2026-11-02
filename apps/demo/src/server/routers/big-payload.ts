import { createTRPCRouter, publicProcedure } from "../trpc";

// About 200 KB once serialized.
const ROWS = Array.from({ length: 2000 }, (_, i) => ({
  id: i,
  label: `row-${i}`,
  notes: "lorem ipsum dolor sit amet ".repeat(3),
  values: [i, i * 2, i * 3],
}));

export const bigPayloadRouter = createTRPCRouter({
  get: publicProcedure.query(() => ({ count: ROWS.length, rows: ROWS })),
});
