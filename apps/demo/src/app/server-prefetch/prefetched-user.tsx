"use client";

import { trpc } from "@/lib/trpc/client";

export function PrefetchedUser() {
  const { data, status } = trpc.user.getById.useQuery({ id: 2 });

  if (!data) return <p id="prefetched">status: {status}</p>;
  return (
    <p id="prefetched">
      {data.name} ({data.role}), created {data.createdAt.toISOString()}
    </p>
  );
}
