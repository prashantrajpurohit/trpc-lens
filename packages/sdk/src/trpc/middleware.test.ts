import { performance } from "node:perf_hooks";
import type { InspectorEvent } from "@prashant-rajpurohit/trpc-inspector-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { init, resetForTests } from "../sdk";
import { connectViewer, downBridge, setupBridge, type TestBridge, type Viewer } from "../test-bridge";
import { runCleanup, waitFor } from "../test-utils";
import { inspectorMiddleware } from "./middleware";
import { buildRouter, fetchCall, outcome } from "./test-router";

const instrumented = buildRouter(inspectorMiddleware());
const control = buildRouter();

beforeEach(() => {
  vi.stubEnv("TRPC_INSPECTOR", "1");
  vi.stubEnv("APP_ENV", "development");
  vi.stubEnv("TRPC_INSPECTOR_MODE", "full");
});

afterEach(async () => {
  await resetForTests();
  await runCleanup();
  vi.unstubAllEnvs();
});

/** Bridge, SDK pointed at it, and a viewer that records every live event. */
async function setup(): Promise<{ b: TestBridge; viewer: Viewer }> {
  const b = await setupBridge();
  const viewer = await connectViewer(b.url, b.token);
  init({ port: b.port, tokenFile: b.tokenFile, projectId: "mw-test" });
  return { b, viewer };
}

/** What the bridge holds, as a fresh viewer's snapshot reports it. */
async function stored(b: TestBridge): Promise<InspectorEvent[]> {
  return (await connectViewer(b.url, b.token)).snapshot.events as InspectorEvent[];
}

/** Calls the same procedure on both routers and checks the outcomes are deep-equal. */
async function direct(call: (caller: ReturnType<typeof instrumented.createCaller>) => Promise<unknown>) {
  const actual = await outcome(call(instrumented.createCaller({})));
  const expected = await outcome(call(control.createCaller({})));
  expect(actual).toEqual(expected);
  return actual as { ok: boolean; value?: unknown; code?: string; message?: string };
}

/** The adapter's error body includes a stack only when isDev; drop it before comparing. */
function withoutStack(body: unknown): unknown {
  return JSON.parse(JSON.stringify(body), (key, value) => (key === "stack" ? undefined : value));
}

/** The `input` query parameter of a captured GET, parsed. */
function urlInput(event: InspectorEvent): unknown {
  return JSON.parse(new URL(event.http!.url).searchParams.get("input")!);
}

async function viaHttp(path: string, input: unknown, method: "GET" | "POST" = "GET") {
  const actual = await fetchCall(instrumented.router, path, input, method);
  const expected = await fetchCall(control.router, path, input, method);
  expect(withoutStack(actual)).toEqual(withoutStack(expected));
  return actual;
}

describe("inspectorMiddleware with a real router and the real bridge", () => {
  it("1. direct server call (createCaller) is captured without http", async () => {
    const { b, viewer } = await setup();
    const result = await direct((c) => c.echo({ n: 2, s: "hi" }));
    expect(result).toEqual({ ok: true, value: { doubled: 4, upper: "HI" } });

    await waitFor(() => viewer.events.length === 2);
    const [event] = await stored(b);
    expect(event).toMatchObject({
      path: "echo",
      type: "query",
      source: "server",
      status: "success",
      projectId: "mw-test",
      input: { n: 2, s: "hi" },
      output: { doubled: 4, upper: "HI" },
    });
    expect(event.http).toBeUndefined();
    expect("http" in event).toBe(false);
  });

  it("2. HTTP execution via the fetch adapter is captured with url, method and path", async () => {
    const { b, viewer } = await setup();
    const get = await viaHttp("echo", { n: 3, s: "x" });
    expect(get).toEqual({ status: 200, body: { result: { data: { doubled: 6, upper: "X" } } } });
    const post = await viaHttp("add", { a: 1, b: 2 }, "POST");
    expect(post).toEqual({ status: 200, body: { result: { data: { sum: 3 } } } });

    await waitFor(() => viewer.events.length === 4);
    const events = await stored(b);
    const echo = events.find((e) => e.path === "echo")!;
    expect(echo).toMatchObject({ type: "query", status: "success", input: { n: 3, s: "x" }, output: { doubled: 6 } });
    expect(echo.http).toEqual({ url: expect.stringContaining("/api/trpc/echo?input="), method: "GET" });
    expect(urlInput(echo)).toEqual({ n: 3, s: "x" });
    const add = events.find((e) => e.path === "add")!;
    expect(add).toMatchObject({ type: "mutation", status: "success", input: { a: 1, b: 2 }, output: { sum: 3 } });
    expect(add.http).toEqual({ url: "http://localhost/api/trpc/add", method: "POST" });
  });

  it("3. query success, mutation success and a NOT_FOUND TRPCError", async () => {
    const { b, viewer } = await setup();
    expect(await direct((c) => c.echo({ n: 5, s: "q" }))).toMatchObject({ ok: true });
    expect(await direct((c) => c.add({ a: 4, b: 6 }))).toEqual({ ok: true, value: { sum: 10 } });
    const failed = await direct((c) => c.missing({ id: "u1" }));
    // The caller still receives the same TRPCError.
    expect(failed).toEqual({
      ok: false,
      name: "TRPCError",
      code: "NOT_FOUND",
      message: 'user "u1" not found',
      cause: undefined,
    });

    await waitFor(() => viewer.events.length === 6);
    const events = await stored(b);
    expect(events.find((e) => e.path === "echo")).toMatchObject({ type: "query", status: "success" });
    expect(events.find((e) => e.path === "add")).toMatchObject({ type: "mutation", status: "success", output: { sum: 10 } });
    const missing = events.find((e) => e.path === "missing")!;
    expect(missing).toMatchObject({
      status: "error",
      input: { id: "u1" },
      error: { code: "NOT_FOUND", message: 'user "u1" not found' },
    });
    expect(missing.output).toBeUndefined();
    expect(missing.error!.stack).toMatch(/^TRPCError: user "u1" not found\n/);
  });

  it("4. input validation failure is BAD_REQUEST with issues (full mode)", async () => {
    const { b, viewer } = await setup();
    const result = await direct((c) => c.echo({ n: "not-a-number", s: "x" } as never));
    expect(result).toMatchObject({ ok: false, code: "BAD_REQUEST", cause: "ZodError" });
    const http = await viaHttp("add", { a: "one", b: 2 }, "POST");
    expect(http.status).toBe(400);

    await waitFor(() => viewer.events.length === 4);
    const events = await stored(b);
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.status).toBe("error");
      expect(event.error!.code).toBe("BAD_REQUEST");
      expect(event.error!.issues).toEqual([
        expect.objectContaining({ code: "invalid_type", path: [event.path === "echo" ? "n" : "a"], message: expect.any(String) }),
      ]);
    }
    // The raw, invalid input is what was captured.
    expect(events.find((e) => e.path === "echo")!.input).toEqual({ n: "not-a-number", s: "x" });
  });

  it("5. pending then final share one id; the bridge holds one entry with the final status", async () => {
    const { b, viewer } = await setup();
    const start = performance.now();
    expect(await direct((c) => c.slow())).toEqual({ ok: true, value: { done: true } });
    const elapsed = performance.now() - start;

    await waitFor(() => viewer.events.length === 2);
    const [pending, final] = viewer.events;
    expect(pending).toMatchObject({ status: "pending", path: "slow" });
    expect(pending.durationMs).toBeUndefined();
    expect(final).toMatchObject({ id: pending.id, status: "success", timestamp: pending.timestamp });

    const events = await stored(b);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: pending.id, status: "success", output: { done: true } });
    // The procedure sleeps 60ms; both calls together took `elapsed`.
    expect(events[0].durationMs).toBeGreaterThanOrEqual(55);
    expect(events[0].durationMs).toBeLessThan(elapsed);
  });

  it("6. 50 concurrent calls with different inputs never mix", async () => {
    const { b, viewer } = await setup();
    const calls = Array.from({ length: 50 }, (_, i) => ({ n: i, s: `call-${i}`, ms: (i * 7) % 23 }));
    const caller = instrumented.createCaller({});
    const results = await Promise.all(
      calls.map((input, i) => (i % 2 ? caller.echo(input) : fetchCall(instrumented.router, "echo", input))),
    );
    results.forEach((r, i) => {
      const value = i % 2 ? r : (r as { body: { result: { data: unknown } } }).body.result.data;
      expect(value).toEqual({ doubled: i * 2, upper: `CALL-${i}` });
    });

    await waitFor(() => viewer.events.length === 100, 10_000);
    const events = await stored(b);
    expect(events).toHaveLength(50);
    expect(new Set(events.map((e) => e.id)).size).toBe(50);
    for (const event of events) {
      const input = event.input as { n: number; s: string };
      expect(event.status).toBe("success");
      expect(input.s).toBe(`call-${input.n}`);
      expect(event.output).toEqual({ doubled: input.n * 2, upper: `CALL-${input.n}` });
      // Even calls went over HTTP, odd ones directly.
      if (input.n % 2) expect(event.http).toBeUndefined();
      else expect(urlInput(event)).toEqual(input);
    }
    // Each pending event carries the same input as its final event.
    for (const pending of viewer.events.filter((e) => e.status === "pending")) {
      expect(events.find((e) => e.id === pending.id)!.input).toEqual(pending.input);
    }
  }, 15_000);

  it("8. bridge down: procedures still succeed and add negligible time", async () => {
    init({ ...(await downBridge()), projectId: "mw-test" });
    const caller = instrumented.createCaller({});
    const controlCaller = control.createCaller({});
    const time = async (fn: () => Promise<unknown>) => {
      const start = performance.now();
      for (let i = 0; i < 300; i++) await fn();
      return (performance.now() - start) / 300;
    };
    // Warm up both paths.
    await time(() => caller.echo({ n: 1, s: "w" }));
    await time(() => controlCaller.echo({ n: 1, s: "w" }));

    const withMiddleware = await time(() => caller.echo({ n: 1, s: "a" }));
    const without = await time(() => controlCaller.echo({ n: 1, s: "a" }));
    expect(await direct((c) => c.add({ a: 1, b: 1 }))).toEqual({ ok: true, value: { sum: 2 } });
    expect(await direct((c) => c.missing({ id: "x" }))).toMatchObject({ ok: false, code: "NOT_FOUND" });
    console.log(`[test 8] mean per call: ${withMiddleware.toFixed(3)}ms instrumented, ${without.toFixed(3)}ms control`);
    expect(withMiddleware - without).toBeLessThan(0.5);
  });

  it("10. shape mode (UAT): no original input or output values reach the bridge", async () => {
    vi.stubEnv("APP_ENV", "uat");
    // Ignored outside development.
    vi.stubEnv("TRPC_INSPECTOR_MODE", "full");
    const { b, viewer } = await setup();
    const originals = ["shape-secret-in", "SHAPE-SECRET-IN", "13572468", "27144936", "secret-user-id", "shape-http-val"];

    await direct((c) => c.echo({ n: 13572468, s: "shape-secret-in" }));
    await direct((c) => c.missing({ id: "secret-user-id" }));
    await direct((c) => c.echo({ n: "shape-secret-in" as never, s: "x" }));
    await viaHttp("echo", { n: 1, s: "shape-http-val" });

    await waitFor(() => viewer.events.length === 8);
    const events = await stored(b);
    expect(events).toHaveLength(4);
    const json = JSON.stringify(events);
    for (const value of originals) expect(json).not.toContain(value);
    expect(json).not.toContain("at "); // no stack frames
    // Shapes are still there.
    expect(events.find((e) => e.input && (e.input as { n?: unknown }).n === "number")).toMatchObject({
      output: { doubled: "number", upper: "string(15)" },
    });
  });

  it("12. middleware before .input() captures the raw input, not the parsed one", async () => {
    const { b, viewer } = await setup();
    const raw = { n: "42", extra: "dropped by zod" };
    expect(await direct((c) => c.coerce(raw as never))).toEqual({ ok: true, value: { n: 42 } });
    // Control for the opposite order: validation first, middleware second.
    expect(await direct((c) => c.coerceAfterInput(raw as never))).toEqual({ ok: true, value: { n: 42 } });

    await waitFor(() => viewer.events.length === 4);
    const events = await stored(b);
    for (const path of ["coerce", "coerceAfterInput"]) {
      expect(events.find((e) => e.path === path)).toMatchObject({ input: raw, output: { n: 42 } });
    }
  });

  it("subscriptions: start is captured, setup failure is an error, messages are not", async () => {
    const { b, viewer } = await setup();
    const caller = instrumented.createCaller({});
    const items: unknown[] = [];
    for await (const item of await caller.ticks()) items.push(item);
    expect(items).toEqual([1]);
    expect(await direct((c) => c.brokenTicks())).toMatchObject({ ok: false, code: "FORBIDDEN" });

    await waitFor(() => viewer.events.length === 3);
    const events = await stored(b);
    expect(events.find((e) => e.path === "ticks")).toMatchObject({ type: "subscription", status: "pending" });
    expect(events.find((e) => e.path === "brokenTicks")).toMatchObject({
      type: "subscription",
      status: "error",
      error: { code: "FORBIDDEN", message: "no stream" },
    });
  });

  it("unreadable HTTP input: the event omits input and the response is unchanged", async () => {
    const { b, viewer } = await setup();
    const req = () => new Request("http://localhost/api/trpc/echo?input=%7Bnot-json");
    const { fetchRequestHandler } = await import("@trpc/server/adapters/fetch");
    const call = async (router: typeof instrumented.router) => {
      const res = await fetchRequestHandler({ endpoint: "/api/trpc", req: req(), router, createContext: ({ req }) => ({ req }) });
      return { status: res.status, body: withoutStack(await res.json()) };
    };
    const actual = await call(instrumented.router);
    expect(actual).toEqual(await call(control.router));
    expect(actual.status).toBe(400);
    // The chain still runs; getRawInput() rejects inside it, so input is omitted and the error recorded.
    await waitFor(() => viewer.events.length === 2);
    const [event] = await stored(b);
    const responseCode = (actual.body as { error: { data: { code: string } } }).error.data.code;
    expect(responseCode).toBe("BAD_REQUEST");
    expect(event).toMatchObject({ path: "echo", status: "error", error: { code: responseCode } });
    expect("input" in event).toBe(false);
    expect(event.http).toMatchObject({ method: "GET" });
  });
});
