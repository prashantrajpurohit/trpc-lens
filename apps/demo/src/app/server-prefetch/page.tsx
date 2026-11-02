import { HydrateClient, trpc } from "@/lib/trpc/server";
import { PrefetchedUser } from "./prefetched-user";

export default async function ServerPrefetchPage() {
  await trpc.user.getById.prefetch({ id: 2 });

  return (
    <main>
      <h1>Server prefetch</h1>
      <HydrateClient>
        <PrefetchedUser />
      </HydrateClient>
    </main>
  );
}
