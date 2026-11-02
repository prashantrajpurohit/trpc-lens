import { trpc } from "@/lib/trpc/server";

export default async function ServerDirectPage() {
  const [user, list, slow] = await Promise.all([
    trpc.user.getById({ id: 1 }),
    trpc.user.list(),
    trpc.slow.compute(),
  ]);

  return (
    <main>
      <h1>Server direct</h1>
      <p id="user">
        {user.name} ({user.role}), created {user.createdAt.toISOString()}
      </p>
      <p id="list">
        {list.users.length} users, roles: {[...list.rolesById.values()].join(", ")}, tags:{" "}
        {[...list.tags].join(", ")}
      </p>
      <p id="slow">slow.compute = {slow.result}</p>
    </main>
  );
}
