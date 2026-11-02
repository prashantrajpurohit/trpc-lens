import { createServer, type Server } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { internals, isEnabled, resetForTests } from "../sdk";
import { runCleanup, sleep } from "../test-utils";
import { inspectorMiddleware } from "./middleware";
import { buildRouter, fetchCall, outcome } from "./test-router";

// Module-load spy: the factory only runs when something actually imports "ws".
// This file must not import "ws" (or the bridge, which does) itself.
const loads = vi.hoisted(() => ({ ws: 0 }));
vi.mock("ws", async (importOriginal) => {
  loads.ws++;
  return importOriginal();
});

// A plain TCP listener stands in for the bridge so every connection attempt is counted.
let server: Server;
let port: number;
let connections = 0;

beforeAll(async () => {
  server = createServer((socket) => {
    connections++;
    socket.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

afterEach(async () => {
  await resetForTests();
  await runCleanup();
  vi.unstubAllEnvs();
});

describe("7. gate off", () => {
  const cases: [string, Record<string, string>][] = [
    ["TRPC_INSPECTOR unset", { APP_ENV: "development" }],
    ["APP_ENV=production", { TRPC_INSPECTOR: "1", APP_ENV: "production" }],
    ["NODE_ENV=development is not a gate", { TRPC_INSPECTOR: "1", NODE_ENV: "development" }],
  ];

  for (const [name, env] of cases) {
    it(name, async () => {
      vi.stubEnv("TRPC_INSPECTOR", undefined);
      vi.stubEnv("APP_ENV", undefined);
      for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
      vi.stubEnv("TRPC_INSPECTOR_PORT", String(port));

      // Spying getHttpInfo shows the middleware does no work beyond the gate check.
      const getHttpInfo = vi.fn(() => ({ url: "/x", method: "GET" }));
      const instrumented = buildRouter(inspectorMiddleware({ getHttpInfo }));
      const control = buildRouter();
      const calls: [string, (r: typeof control) => Promise<unknown>][] = [
        ["query", (r) => r.createCaller({}).echo({ n: 1, s: "a" })],
        ["mutation", (r) => r.createCaller({}).add({ a: 1, b: 2 })],
        ["error", (r) => r.createCaller({}).missing({ id: "u" })],
        ["validation", (r) => r.createCaller({}).echo({ n: "x" } as never)],
        ["http", (r) => fetchCall(r.router, "echo", { n: 2, s: "b" })],
      ];
      for (const [label, call] of calls) {
        expect(await outcome(call(instrumented)), label).toEqual(await outcome(call(control)));
      }
      await sleep(300);

      expect(isEnabled()).toBe(false);
      expect(getHttpInfo).not.toHaveBeenCalled();
      expect(connections).toBe(0);
      expect(loads.ws).toBe(0);
      expect(internals().transport).toBeUndefined();
    });
  }
});
