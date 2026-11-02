"use client";

import { TRPCClientError } from "@trpc/client";
import { useState } from "react";
import { trpc } from "@/lib/trpc/client";
import type { AppRouter } from "@/server/routers/_app";

type Call = { label: string; run: () => Promise<unknown> };

export function ClientCalls() {
  const utils = trpc.useUtils();
  const createPost = trpc.post.create.useMutation();
  const [log, setLog] = useState<string[]>([]);

  const calls: Call[] = [
    { label: "query", run: () => utils.client.user.getById.query({ id: 3 }) },
    {
      label: "mutation",
      run: () =>
        createPost.mutateAsync({ title: "Fake post", email: "writer@example.test", password: "not-a-real-pass" }),
    },
    { label: "not-found", run: () => utils.client.post.findMissing.query() },
    { label: "unauthorized", run: () => utils.client.me.profile.query() },
    // Deliberately the wrong type, to trigger zod validation.
    { label: "invalid-input", run: () => utils.client.user.getById.query({ id: "seven" as unknown as number }) },
  ];

  const record = async ({ label, run }: Call) => {
    let line: string;
    try {
      await run();
      line = `${label}: ok`;
    } catch (error) {
      const code = error instanceof TRPCClientError ? (error as TRPCClientError<AppRouter>).data?.code : undefined;
      line = `${label}: error ${code ?? "unknown"}`;
    }
    setLog((prev) => [...prev, line]);
  };

  // Started in the same tick so httpBatchLink batches them.
  const fireAll = () => Promise.all(calls.map(record));

  return (
    <section>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {calls.map((call) => (
          <button key={call.label} id={`btn-${call.label}`} onClick={() => record(call)}>
            {call.label}
          </button>
        ))}
        <button id="btn-all" onClick={fireAll}>
          fire all at once
        </button>
      </div>
      <ol id="log">
        {log.map((line, i) => (
          <li key={i}>{line}</li>
        ))}
      </ol>
    </section>
  );
}
