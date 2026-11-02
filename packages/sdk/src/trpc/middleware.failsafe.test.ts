import type { InspectorEvent } from "@prashant-rajpurohit/trpc-inspector-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emitEvent } from "../sdk";
import { inspectorMiddleware } from "./middleware";
import { buildRouter, fetchCall, outcome } from "./test-router";

vi.mock("../sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sdk")>()),
  isEnabled: () => true,
  emitEvent: vi.fn(),
}));

const emit = vi.mocked(emitEvent);
const control = buildRouter();

afterEach(() => {
  emit.mockReset();
});

type Call = (r: ReturnType<typeof buildRouter>) => Promise<unknown>;
const calls: [string, Call][] = [
  ["query", (r) => r.createCaller({}).echo({ n: 1, s: "a" })],
  ["mutation", (r) => r.createCaller({}).add({ a: 1, b: 2 })],
  ["error", (r) => r.createCaller({}).missing({ id: "u" })],
  ["validation", (r) => r.createCaller({}).echo({ n: "x" } as never)],
  ["http", (r) => fetchCall(r.router, "echo", { n: 2, s: "b" })],
  ["http error", (r) => fetchCall(r.router, "missing", { id: "u" }, "GET")],
];

async function expectUnchanged(instrumented: ReturnType<typeof buildRouter>) {
  for (const [label, call] of calls) {
    const actual = await outcome(call(instrumented));
    const expected = await outcome(call(control));
    // The adapter's error body carries a stack in some environments; the rest must match.
    const strip = (v: unknown) => JSON.parse(JSON.stringify(v), (k, x) => (k === "stack" ? undefined : x));
    expect(strip(actual), label).toEqual(strip(expected));
  }
}

describe("9. instrumentation failures never change the procedure's outcome", () => {
  it("emitEvent throws", async () => {
    emit.mockImplementation(() => {
      throw new Error("emit failed");
    });
    await expectUnchanged(buildRouter(inspectorMiddleware()));
    expect(emit).toHaveBeenCalled();
  });

  it("emitEvent throws only for the final event", async () => {
    emit.mockImplementation((event: InspectorEvent) => {
      if (event.status !== "pending") throw new Error("emit failed");
    });
    await expectUnchanged(buildRouter(inspectorMiddleware()));
  });

  it("getHttpInfo throws: the event is still emitted, without http", async () => {
    const instrumented = buildRouter(
      inspectorMiddleware({
        getHttpInfo: () => {
          throw new Error("no http");
        },
      }),
    );
    await expectUnchanged(instrumented);
    expect(emit.mock.calls.length).toBe(calls.length * 2);
    for (const [event] of emit.mock.calls) expect(event.http).toBeUndefined();
  });

  it("getHttpInfo returns garbage: ignored", async () => {
    const instrumented = buildRouter(inspectorMiddleware({ getHttpInfo: () => ({ url: 1, method: null }) as never }));
    await expectUnchanged(instrumented);
    for (const [event] of emit.mock.calls) expect(event.http).toBeUndefined();
  });

  it("a ctx.req whose url getter throws: ignored", async () => {
    const { createCaller } = buildRouter(inspectorMiddleware());
    const req = {
      method: "GET",
      get url(): string {
        throw new Error("boom");
      },
    };
    const result = await createCaller({ req: req as unknown as Request }).echo({ n: 1, s: "a" });
    expect(result).toEqual({ doubled: 2, upper: "A" });
    expect(emit.mock.calls.map(([e]) => e.status)).toEqual(["pending", "success"]);
    expect(emit.mock.calls[0][0].http).toBeUndefined();
  });

});

describe("results and throws pass through untouched", () => {
  // tRPC turns throws into `ok: false` results, so a throwing next() is driven directly.
  const opts = (next: () => Promise<unknown>) =>
    ({ ctx: {}, type: "query", path: "p", input: undefined, getRawInput: async () => ({ a: 1 }), meta: undefined, signal: undefined, batchIndex: 0, next }) as never;

  it("rethrows the exact error next() threw, and records it", async () => {
    const error = Object.assign(new Error("downstream"), { code: "CONFLICT" });
    const promise = inspectorMiddleware()(opts(() => Promise.reject(error)));
    await expect(promise).rejects.toBe(error);
    expect(emit.mock.calls.map(([e]) => e.status)).toEqual(["pending", "error"]);
    expect(emit.mock.calls[1][0].error).toMatchObject({ code: "CONFLICT", message: "downstream" });
  });

  it("returns the exact result object next() returned", async () => {
    const ok = { ok: true, data: { x: 1 }, marker: "middlewareMarker" };
    const fail = { ok: false, error: new Error("e"), marker: "middlewareMarker" };
    expect(await inspectorMiddleware()(opts(async () => ok))).toBe(ok);
    expect(await inspectorMiddleware()(opts(async () => fail))).toBe(fail);
  });

  it("getRawInput rejecting: input omitted, call proceeds", async () => {
    const ok = { ok: true, data: 1, marker: "middlewareMarker" };
    const o = opts(async () => ok) as unknown as Record<string, unknown>;
    o.getRawInput = () => Promise.reject(new Error("bad body"));
    expect(await inspectorMiddleware()(o as never)).toBe(ok);
    expect(emit.mock.calls.map(([e]) => e.status)).toEqual(["pending", "success"]);
    expect("input" in emit.mock.calls[0][0]).toBe(false);
  });
});
