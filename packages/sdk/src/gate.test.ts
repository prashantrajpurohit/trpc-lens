import { writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
// Static import before any env is stubbed: proves the gate is not evaluated at import time.
import { emitEvent, init, internals, isEnabled, resetForTests } from "./sdk";
import { makeEvent, runCleanup, sleep, tempDir, waitFor } from "./test-utils";

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

describe("1. gate off", () => {
  const cases: [string, Record<string, string>][] = [
    ["TRPC_INSPECTOR unset", { APP_ENV: "development" }],
    ["APP_ENV=production", { TRPC_INSPECTOR: "1", APP_ENV: "production" }],
    ["APP_ENV unset", { TRPC_INSPECTOR: "1" }],
    ["NODE_ENV=development is not a gate", { TRPC_INSPECTOR: "1", NODE_ENV: "development" }],
  ];

  for (const [name, env] of cases) {
    it(name, async () => {
      vi.stubEnv("TRPC_INSPECTOR", undefined);
      vi.stubEnv("APP_ENV", undefined);
      for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
      vi.stubEnv("TRPC_INSPECTOR_PORT", String(port));

      expect(isEnabled()).toBe(false);
      expect(() => {
        for (let i = 0; i < 100; i++) emitEvent(makeEvent({ input: { a: 1 } }));
      }).not.toThrow();
      await sleep(300);

      expect(connections).toBe(0);
      expect(loads.ws).toBe(0);
      expect(internals().transport).toBeUndefined();
    });
  }
});

describe("gate on (control for the spies above)", () => {
  it("imports ws only after the gate passes, evaluated lazily at first use", async () => {
    expect(loads.ws).toBe(0);
    vi.stubEnv("TRPC_INSPECTOR", "1");
    vi.stubEnv("APP_ENV", "development");
    vi.stubEnv("TRPC_INSPECTOR_PORT", String(port));
    // Any token works: this listener is not a bridge.
    const tokenFile = join(tempDir(), "token");
    writeFileSync(tokenFile, "a".repeat(64));
    init({ tokenFile });

    expect(isEnabled()).toBe(true);
    expect(loads.ws).toBe(0); // enabling alone does not connect
    emitEvent(makeEvent());
    await waitFor(() => connections > 0);
    expect(loads.ws).toBe(1);
  });
});
