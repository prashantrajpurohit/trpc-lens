import { writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SdkOptions } from "./config";
import { emitEvent, init, internals, isEnabled, newId, resetForTests, shutdown } from "./sdk";
import { connectViewer, downBridge, openProducers, setupBridge, type TestBridge } from "./test-bridge";
import { connectLoopback } from "./transport";
import { makeEvent, runCleanup, sleep, tempDir, waitFor } from "./test-utils";

const PROJECT = "app-test";

beforeEach(() => {
  vi.stubEnv("TRPC_INSPECTOR", "1");
  vi.stubEnv("APP_ENV", "development");
  vi.stubEnv("TRPC_INSPECTOR_MODE", "");
});

afterEach(async () => {
  await resetForTests();
  await runCleanup();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function initFor(b: { port: number; tokenFile: string }, extra: SdkOptions = {}) {
  return init({ port: b.port, tokenFile: b.tokenFile, projectId: PROJECT, ...extra });
}

/** Stored events at the bridge, as a fresh viewer's snapshot reports them. */
async function stored(b: TestBridge) {
  return (await connectViewer(b.url, b.token)).snapshot.events;
}

describe("sdk with the real bridge", () => {
  it("2. delivers an event to a connected viewer, with the configured projectId", async () => {
    const b = await setupBridge();
    const viewer = await connectViewer(b.url, b.token);
    initFor(b);
    expect(isEnabled()).toBe(true);

    const event = makeEvent({ projectId: "someone-else", input: { id: 1 } });
    emitEvent(event);
    const message = await viewer.next();
    expect(message.type).toBe("event");
    expect(message.event).toMatchObject({ id: event.id, projectId: PROJECT, path: "user.get", input: { id: "number" } });
  });

  it("3. pending then success with the same id is one entry at the bridge", async () => {
    const b = await setupBridge();
    const viewer = await connectViewer(b.url, b.token);
    initFor(b);
    const id = newId();
    emitEvent(makeEvent({ id, status: "pending" }));
    emitEvent(makeEvent({ id, status: "success", output: { ok: true }, durationMs: 12 }));
    await waitFor(() => viewer.events.length === 2);

    const events = await stored(b);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id, status: "success", durationMs: 12 });
  });

  it("4. bridge down: emitEvent is fast, does not throw, and memory stays at the queue cap", async () => {
    initFor(await downBridge());
    const times: number[] = [];
    for (let i = 0; i < 1000; i++) {
      const start = performance.now();
      emitEvent(makeEvent({ input: { i, text: "some input" } }));
      times.push(performance.now() - start);
    }
    expect(Math.max(...times)).toBeLessThan(5);
    expect(internals().transport!.queueLength).toBe(200);
  });

  it("5. events queued while the bridge was down arrive after it starts, oldest dropped", async () => {
    const down = await downBridge();
    initFor(down, { queueSize: 20, backoffMinMs: 50, backoffMaxMs: 200 });
    for (let i = 0; i < 30; i++) emitEvent(makeEvent({ id: `q-${i}` }));
    await waitFor(() => internals().transport!.attempts >= 2);

    const b = await setupBridge({ port: down.port, tokenFile: down.tokenFile });
    const viewer = await connectViewer(b.url, b.token);
    await waitFor(() => viewer.events.length >= 20);
    await sleep(100);
    expect(viewer.events.map((e) => e.id)).toEqual(Array.from({ length: 20 }, (_, i) => `q-${i + 10}`));
  });

  it("6a. full mode: password is redacted at the bridge", async () => {
    vi.stubEnv("TRPC_INSPECTOR_MODE", "full");
    const b = await setupBridge();
    const viewer = await connectViewer(b.url, b.token);
    initFor(b);
    emitEvent(makeEvent({ input: { username: "alice", password: "hunter2" } }));
    const { event } = await viewer.next();
    expect(event.input).toEqual({ username: "alice", password: "[REDACTED]" });
    expect(JSON.stringify(await stored(b))).not.toContain("hunter2");
  });

  it("6b. shape mode: no original string or number value is stored at the bridge", async () => {
    const b = await setupBridge();
    const viewer = await connectViewer(b.url, b.token);
    initFor(b);
    const originals = ["shape-user@example.com", "9876543", "output-value-xyz", "url-param-value", "quoted-msg-value"];
    emitEvent(
      makeEvent({
        status: "error",
        input: { email: "shape-user@example.com", count: 9876543 },
        output: { note: "output-value-xyz" },
        http: { url: "/api/trpc/user.get?foo=url-param-value", method: "GET" },
        error: { message: 'failed for "quoted-msg-value"', stack: "Error\n at secret-stack-frame" },
      }),
    );
    await viewer.next();
    const json = JSON.stringify(await stored(b));
    for (const value of [...originals, "secret-stack-frame"]) expect(json).not.toContain(value);
  });

  it("7. UAT forces shape mode even with TRPC_INSPECTOR_MODE=full", async () => {
    vi.stubEnv("APP_ENV", "uat");
    vi.stubEnv("TRPC_INSPECTOR_MODE", "full");
    const b = await setupBridge();
    const viewer = await connectViewer(b.url, b.token);
    initFor(b);
    emitEvent(makeEvent({ input: { name: "alice" }, error: { message: "x", stack: "Error\n at frame" } }));
    const { event } = await viewer.next();
    expect(event.input).toEqual({ name: "string(5)" });
    expect(event.error).not.toHaveProperty("stack");
  });

  it("10. an invalid event is dropped and never sent", async () => {
    const b = await setupBridge();
    const viewer = await connectViewer(b.url, b.token);
    initFor(b);
    emitEvent({ id: 42 } as never);
    emitEvent(makeEvent({ status: "bogus" as never }));
    const valid = makeEvent();
    emitEvent(valid);
    expect((await viewer.next()).event.id).toBe(valid.id);

    await shutdown();
    await waitFor(() => b.logs.some((l) => l.line.startsWith("producer disconnected")));
    expect(b.logs.map((l) => l.line)).toContain("producer disconnected (accepted: 1, invalid: 0, dropped: 0)");
  });

  it("drops an event whose frame would exceed the bridge's payload limit, without losing the connection", async () => {
    vi.stubEnv("TRPC_INSPECTOR_MODE", "full");
    const b = await setupBridge();
    const viewer = await connectViewer(b.url, b.token);
    initFor(b);
    // Full mode keeps error.message as is, so this is the one field that can be huge.
    emitEvent(makeEvent({ id: "huge", status: "error", error: { message: "x".repeat(300 * 1024) } }));
    emitEvent(makeEvent({ id: "small" }));
    expect((await viewer.next()).event.id).toBe("small");
    expect(openProducers(b.logs)).toBe(1);
  });

  it("11. init twice and a simulated hot reload leave exactly one open connection", async () => {
    const b = await setupBridge();
    const viewer = await connectViewer(b.url, b.token);

    initFor(b);
    initFor(b);
    emitEvent(makeEvent({ id: "before-reload" }));
    await waitFor(() => viewer.events.length === 1);

    // Next.js re-evaluates the module; the new copy must find the existing connection.
    vi.resetModules();
    const reloaded = await import("./sdk");
    expect(reloaded.emitEvent).not.toBe(emitEvent);
    reloaded.init({ port: b.port, tokenFile: b.tokenFile, projectId: PROJECT });
    reloaded.emitEvent(makeEvent({ id: "after-reload" }));
    await waitFor(() => viewer.events.length === 2);
    await sleep(200);
    expect(openProducers(b.logs)).toBe(1);
    expect(b.logs.filter((l) => l.line.startsWith("producer connected"))).toHaveLength(1);

    // Changed config replaces the connection: the old one is closed first.
    reloaded.init({ port: b.port, tokenFile: b.tokenFile, projectId: PROJECT, queueSize: 50 });
    reloaded.emitEvent(makeEvent({ id: "after-replace" }));
    await waitFor(() => viewer.events.length === 3);
    await waitFor(() => b.logs.some((l) => l.line.startsWith("producer disconnected")));
    await sleep(200);
    expect(openProducers(b.logs)).toBe(1);
    expect(viewer.events.map((e) => e.id)).toEqual(["before-reload", "after-reload", "after-replace"]);
  });

  it("12. a non-loopback host option or env value is ignored", async () => {
    vi.stubEnv("TRPC_INSPECTOR_HOST", "10.1.2.3");
    const b = await setupBridge();
    const viewer = await connectViewer(b.url, b.token);
    init({ port: b.port, tokenFile: b.tokenFile, projectId: PROJECT, host: "192.168.1.50" } as SdkOptions);
    expect(internals().url).toBe(`ws://127.0.0.1:${b.port}`);
    emitEvent(makeEvent());
    expect((await viewer.next()).type).toBe("event");
  });

  it("12b. the socket factory dials 127.0.0.1 whatever host it is given", async () => {
    const remote = new Promise<string | undefined>((resolve) => {
      const server = createServer((socket) => {
        resolve(socket.localAddress);
        socket.destroy();
        server.close();
      });
      server.listen(0, "127.0.0.1", () => {
        const { port } = server.address() as { port: number };
        const socket = connectLoopback({ port, host: "10.9.9.9" } as never);
        socket.on("error", () => {});
      });
    });
    expect(await remote).toBe("127.0.0.1");
  });

  it(
    "13. wrong token: the bridge rejects, the SDK does not throw, retries with backoff, recovers when fixed",
    async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const b = await setupBridge();
      const viewer = await connectViewer(b.url, b.token);
      const tokenFile = join(tempDir(), "token");
      writeFileSync(tokenFile, "0".repeat(64));
      initFor({ port: b.port, tokenFile }, { backoffMinMs: 100, backoffMaxMs: 800 });

      expect(() => emitEvent(makeEvent({ id: "held" }))).not.toThrow();
      await sleep(2_000);
      const rejections = b.logs.filter((l) => l.line.endsWith("rejected: unauthorized")).map((l) => l.at);
      const gaps = rejections.slice(1).map((at, i) => at - rejections[i]!);
      expect(rejections.length).toBeGreaterThanOrEqual(3);
      expect(rejections.length).toBeLessThanOrEqual(6);
      expect(gaps[1]!).toBeGreaterThan(gaps[0]! * 1.4);
      expect(gaps[2]!).toBeGreaterThan(gaps[1]! * 1.4);
      // The event was held back, not sent into the rejected connection.
      expect(internals().transport!.queueLength).toBe(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).not.toContain(b.token);

      // The token is re-read on reconnect.
      writeFileSync(tokenFile, b.token);
      await waitFor(() => viewer.events.length === 1, 3_000);
      expect(viewer.events[0]!.id).toBe("held");
    },
    10_000,
  );

  it("13b. a missing token file means 'not available': no throw, events held, retried", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    initFor({ port: 1, tokenFile: join(tempDir(), "missing") }, { backoffMinMs: 20, backoffMaxMs: 40 });
    for (let i = 0; i < 5; i++) emitEvent(makeEvent());
    await waitFor(() => internals().transport!.attempts >= 3);
    expect(internals().transport!.queueLength).toBe(5);
    expect(internals().transport!.opened).toBe(0);
  });

  it(
    "14. nothing event-related reaches stdout/stderr, and at most one warning line",
    async () => {
      const spies = [
        vi.spyOn(console, "log").mockImplementation(() => {}),
        vi.spyOn(console, "info").mockImplementation(() => {}),
        vi.spyOn(console, "warn").mockImplementation(() => {}),
        vi.spyOn(console, "error").mockImplementation(() => {}),
        vi.spyOn(console, "debug").mockImplementation(() => {}),
        vi.spyOn(process.stdout, "write"),
        vi.spyOn(process.stderr, "write"),
      ];
      const markers = ["marker-input-6d1f", "marker-output-93ab", "marker-url-77c2", "marker-error-4e0d"];
      const event = () =>
        makeEvent({
          status: "error",
          input: { a: markers[0] },
          output: { b: markers[1] },
          http: { url: `/api/trpc/x?q=${markers[2]}`, method: "GET" },
          error: { message: markers[3]!, stack: markers[3] },
        });

      // Bridge down first, then up.
      const down = await downBridge();
      vi.stubEnv("TRPC_INSPECTOR_MODE", "full");
      initFor(down, { backoffMinMs: 50, backoffMaxMs: 100 });
      for (let i = 0; i < 50; i++) emitEvent(event());
      await sleep(200);
      const b = await setupBridge({ port: down.port, tokenFile: down.tokenFile, log: false });
      const viewer = await connectViewer(b.url, b.token);
      await waitFor(() => viewer.events.length === 50);
      // Full mode really carried the values, so the absence below is meaningful.
      expect(JSON.stringify(viewer.events)).toContain(markers[0]);
      emitEvent({ id: 1, input: markers[0] } as never);
      await sleep(100);

      const written = spies.flatMap((s) => s.mock.calls.map((args) => args.map(String).join(" "))).join("\n");
      for (const marker of markers) expect(written).not.toContain(marker);
      expect(written).not.toContain(b.token);
      const sdkLines = written.split("\n").filter((line) => line.includes("[trpc-inspector]"));
      expect(sdkLines).toHaveLength(1);
    },
    10_000,
  );

  it("newId returns a UUID; shutdown is safe to call any time", async () => {
    expect(newId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    await expect(shutdown()).resolves.toBeUndefined();
    await expect(shutdown()).resolves.toBeUndefined();
  });
});
