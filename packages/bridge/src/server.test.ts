import { mkdtempSync, rmSync } from "node:fs";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InspectorEvent } from "@prashant-rajpurohit/trpc-inspector-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, type ClientOptions } from "ws";
import { startBridge, type BridgeOptions } from "./server";
import { loadOrCreateToken } from "./token";

const ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Message = { type: string; [key: string]: any };

interface Client {
  ws: WebSocket;
  send(value: unknown): void;
  next(): Promise<Message>;
  closed: Promise<{ code: number; reason: string }>;
}

const cleanup: (() => unknown)[] = [];

afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function setup(options: Partial<BridgeOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "trpc-bridge-"));
  const tokenFile = join(dir, "token");
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const bridge = await startBridge({
    port: 0,
    tokenFile,
    allowedViewerOrigins: [ORIGIN],
    log: false,
    ...options,
  });
  cleanup.push(() => bridge.close());
  const { token } = loadOrCreateToken(tokenFile);
  return { bridge, token, url: `ws://127.0.0.1:${bridge.port}` };
}

function open(url: string, options: ClientOptions = {}): Promise<Client> {
  const ws = new WebSocket(url, options);
  const queue: Message[] = [];
  const waiters: ((message: Message) => void)[] = [];
  ws.on("message", (data) => {
    const message = JSON.parse(data.toString()) as Message;
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else queue.push(message);
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    ws.on("close", (code, reason) => resolve({ code, reason: reason.toString() })),
  );
  cleanup.push(() => ws.terminate());

  const client: Client = {
    ws,
    send: (value) => ws.send(typeof value === "string" ? value : JSON.stringify(value)),
    next: () =>
      queue.length > 0 ? Promise.resolve(queue.shift()!) : new Promise((resolve) => waiters.push(resolve)),
    closed,
  };
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(client));
    ws.once("error", reject);
    ws.on("error", () => {});
  });
}

/** Resolves with the HTTP status of a rejected upgrade. */
function upgradeStatus(url: string, options: ClientOptions = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, options);
    ws.on("error", () => {});
    ws.on("unexpected-response", (req, res) => {
      resolve(res.statusCode ?? 0);
      req.destroy();
    });
    ws.on("open", () => {
      ws.terminate();
      reject(new Error("upgrade was accepted"));
    });
  });
}

async function viewer(url: string, token: string) {
  const client = await open(url, { origin: ORIGIN });
  client.send({ type: "hello", token, role: "viewer" });
  const snapshot = await client.next();
  expect(snapshot.type).toBe("snapshot");
  return { client, snapshot };
}

async function producer(url: string, token: string, projectId = "app-a") {
  const client = await open(url);
  client.send({ type: "hello", token, role: "producer", projectId });
  return client;
}

let seq = 0;
function makeEvent(overrides: Partial<InspectorEvent> = {}): InspectorEvent {
  return {
    id: `evt-${++seq}`,
    projectId: "app-a",
    timestamp: 1_700_000_000_000 + seq,
    path: "user.get",
    type: "query",
    source: "client",
    status: "pending",
    ...overrides,
  };
}

const eventMessage = (event: InspectorEvent) => ({ type: "event", event });

describe("bridge: functional", () => {
  it("1. forwards a producer event to a connected viewer", async () => {
    const { url, token } = await setup();
    const v = await viewer(url, token);
    const p = await producer(url, token);
    const event = makeEvent({ input: { id: 1 }, http: { url: "/api/trpc/user.get", method: "GET" } });
    p.send(eventMessage(event));
    expect(await v.client.next()).toEqual(eventMessage(event));
  });

  it("2. sends history to a viewer that connects later", async () => {
    const { url, token } = await setup();
    const p = await producer(url, token);
    const event = makeEvent();
    p.send(eventMessage(event));
    const early = await viewer(url, token);
    // The early viewer may have received it in its snapshot or as a stream message.
    if (early.snapshot.events.length === 0) await early.client.next();

    const late = await viewer(url, token);
    expect(late.snapshot).toEqual({ type: "snapshot", events: [event], projects: ["app-a"] });
  });

  it("3. collapses pending -> success with the same id into one entry", async () => {
    const { url, token } = await setup();
    const v = await viewer(url, token);
    const p = await producer(url, token);
    const pending = makeEvent();
    const success = { ...pending, status: "success" as const, output: { ok: true }, durationMs: 12 };
    p.send(eventMessage(pending));
    p.send(eventMessage(success));
    expect(await v.client.next()).toEqual(eventMessage(pending));
    expect(await v.client.next()).toEqual(eventMessage(success));

    const late = await viewer(url, token);
    expect(late.snapshot.events).toEqual([success]);
  });

  it("4. caps history at historyPerProject", async () => {
    const { url, token } = await setup({ historyPerProject: 3 });
    const v = await viewer(url, token);
    const p = await producer(url, token);
    const events = Array.from({ length: 5 }, () => makeEvent());
    for (const event of events) p.send(eventMessage(event));
    for (let i = 0; i < events.length; i++) await v.client.next();

    const late = await viewer(url, token);
    expect(late.snapshot.events).toEqual(events.slice(2));
  });

  it("5. clear empties history (one project or all) and notifies viewers", async () => {
    const { url, token } = await setup();
    const v1 = await viewer(url, token);
    const v2 = await viewer(url, token);
    const pa = await producer(url, token, "app-a");
    const pb = await producer(url, token, "app-b");
    const a = makeEvent({ projectId: "app-a" });
    const b = makeEvent({ projectId: "app-b" });
    pa.send(eventMessage(a));
    await v1.client.next();
    await v2.client.next();
    pb.send(eventMessage(b));
    await v1.client.next();
    await v2.client.next();

    v1.client.send({ type: "clear", projectId: "app-a" });
    expect(await v1.client.next()).toEqual({ type: "cleared", projectId: "app-a" });
    expect(await v2.client.next()).toEqual({ type: "cleared", projectId: "app-a" });
    expect((await viewer(url, token)).snapshot).toEqual({
      type: "snapshot",
      events: [b],
      projects: ["app-b"],
    });

    v2.client.send({ type: "clear" });
    expect(await v1.client.next()).toEqual({ type: "cleared" });
    expect(await v2.client.next()).toEqual({ type: "cleared" });
    expect((await viewer(url, token)).snapshot).toEqual({ type: "snapshot", events: [], projects: [] });
  });

  it("6. survives a producer disconnect; viewers can reconnect and get a snapshot", async () => {
    const { url, token } = await setup();
    const v = await viewer(url, token);
    const p1 = await producer(url, token);
    const e1 = makeEvent();
    p1.send(eventMessage(e1));
    await v.client.next();
    p1.ws.close();
    await p1.closed;
    expect(v.client.ws.readyState).toBe(WebSocket.OPEN);

    const p2 = await producer(url, token);
    const e2 = makeEvent();
    p2.send(eventMessage(e2));
    expect(await v.client.next()).toEqual(eventMessage(e2));

    v.client.ws.close();
    await v.client.closed;
    const again = await viewer(url, token);
    expect(again.snapshot.events).toEqual([e1, e2]);
  });

  it("7. keeps projects separate and rejects a mismatched projectId", async () => {
    const { url, token } = await setup();
    const v = await viewer(url, token);
    const pa = await producer(url, token, "app-a");
    const pb = await producer(url, token, "app-b");
    const spoofed = makeEvent({ projectId: "app-b" });
    const a = makeEvent({ projectId: "app-a" });
    const b = makeEvent({ projectId: "app-b" });

    pa.send(eventMessage(spoofed));
    pa.send(eventMessage(a));
    // Messages on one connection are processed in order, so if `a` arrives
    // first, `spoofed` was already rejected.
    expect(await v.client.next()).toEqual(eventMessage(a));
    pb.send(eventMessage(b));
    expect(await v.client.next()).toEqual(eventMessage(b));

    const late = await viewer(url, token);
    expect(late.snapshot).toEqual({ type: "snapshot", events: [a, b], projects: ["app-a", "app-b"] });
  });
});

describe("bridge: security", () => {
  it("8. rejects a wrong or missing token", async () => {
    const { url, token } = await setup();
    const wrong = "0".repeat(token.length);

    const p = await producer(url, wrong);
    expect(await p.closed).toEqual({ code: 1008, reason: "unauthorized" });

    const v = await open(url, { origin: ORIGIN });
    v.send({ type: "hello", token: wrong.slice(1), role: "viewer" });
    expect((await v.closed).code).toBe(1008);

    const missing = await open(url);
    missing.send({ type: "hello", role: "producer", projectId: "app-a" });
    expect((await missing.closed).code).toBe(1008);
  });

  it("9. closes a connection that sends no hello within 3 seconds", async () => {
    const { url } = await setup();
    const started = Date.now();
    const c = await open(url);
    expect(await c.closed).toEqual({ code: 1008, reason: "hello timeout" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(2_900);
  }, 10_000);

  it("10. rejects a wrong Host header at upgrade", async () => {
    const { url, token, bridge } = await setup();
    expect(await upgradeStatus(url, { headers: { Host: "evil.com" } })).toBe(403);
    expect(await upgradeStatus(url, { headers: { Host: `evil.com:${bridge.port}` } })).toBe(403);
    expect(await upgradeStatus(url, { headers: { Host: `localhost.evil.com:${bridge.port}` } })).toBe(403);
    expect(await upgradeStatus(url, { headers: { Host: `127.0.0.1:${bridge.port + 1}` } })).toBe(403);
    expect(await upgradeStatus(url, { headers: { Host: "127.0.0.1" } })).toBe(403);

    // Both allowed spellings still work.
    const viaIp = await open(url);
    expect(viaIp.ws.readyState).toBe(WebSocket.OPEN);
    const viaLocalhost = await open(url, { headers: { Host: `localhost:${bridge.port}` } });
    viaLocalhost.send({ type: "hello", token, role: "producer", projectId: "app-a" });
    viaLocalhost.send(eventMessage(makeEvent()));
    expect((await viewer(url, token)).snapshot.events).toHaveLength(1);
  });

  it("11. rejects a disallowed Origin at upgrade", async () => {
    const { url } = await setup();
    expect(await upgradeStatus(url, { origin: "https://evil.com" })).toBe(403);
    expect(await upgradeStatus(url, { origin: "null" })).toBe(403);
    expect(await upgradeStatus(url, { origin: `${ORIGIN}.evil.com` })).toBe(403);
  });

  it("12. rejects a producer with an Origin and a viewer without one", async () => {
    const { url, token } = await setup();
    const browserProducer = await open(url, { origin: ORIGIN });
    browserProducer.send({ type: "hello", token, role: "producer", projectId: "app-a" });
    expect((await browserProducer.closed).code).toBe(1008);

    const originlessViewer = await open(url);
    originlessViewer.send({ type: "hello", token, role: "viewer" });
    expect((await originlessViewer.closed).code).toBe(1008);

    const noProject = await open(url);
    noProject.send({ type: "hello", token, role: "producer" });
    expect((await noProject.closed).code).toBe(1008);
  });

  it("13. closes the connection on a message over maxPayloadBytes", async () => {
    const { url, token } = await setup({ maxPayloadBytes: 1024 });
    const p = await producer(url, token);
    p.send(eventMessage(makeEvent({ input: "x".repeat(2048) })));
    expect((await p.closed).code).toBe(1009);

    const beforeHello = await open(url);
    beforeHello.send("x".repeat(2048));
    expect((await beforeHello.closed).code).toBe(1009);
  });

  it("14. neither stores nor forwards an invalid event", async () => {
    const { url, token } = await setup();
    const v = await viewer(url, token);
    const p = await producer(url, token);
    const valid = makeEvent();

    p.send({ type: "event", event: { ...makeEvent(), status: "bogus" } });
    p.send({ type: "event", event: { ...makeEvent(), timestamp: "yesterday" } });
    p.send({ type: "event", event: makeEvent(), extra: true });
    p.send({ type: "something-else" });
    p.send("not json");
    p.send(eventMessage(valid));

    expect(await v.client.next()).toEqual(eventMessage(valid));
    const late = await viewer(url, token);
    expect(late.snapshot.events).toEqual([valid]);
  });

  it("14b. closes a connection after 20 invalid messages", async () => {
    const { url, token } = await setup();
    const p = await producer(url, token);
    for (let i = 0; i < 20; i++) p.send({ type: "event", event: { nope: true } });
    expect(await p.closed).toEqual({ code: 1008, reason: "too many invalid messages" });
  });

  it("15. rejects binary frames", async () => {
    const { url, token } = await setup();
    const p = await producer(url, token);
    p.ws.send(Buffer.from(JSON.stringify(eventMessage(makeEvent()))), { binary: true });
    expect((await p.closed).code).toBe(1003);

    const beforeHello = await open(url);
    beforeHello.ws.send(Buffer.from(JSON.stringify({ type: "hello", token, role: "producer", projectId: "a" })), {
      binary: true,
    });
    expect((await beforeHello.closed).code).toBe(1003);
  });

  it("16. closes a connection that exceeds the rate limit", async () => {
    const { url, token } = await setup({ rateLimitPerSecond: 5 });
    const p = await producer(url, token);
    for (let i = 0; i < 10; i++) p.send(eventMessage(makeEvent()));
    expect(await p.closed).toEqual({ code: 1008, reason: "rate limit exceeded" });
  });

  it("17. listens on 127.0.0.1 only and serves no HTTP endpoints", async () => {
    const { bridge } = await setup();
    expect(bridge.address()).toMatchObject({ address: "127.0.0.1", family: "IPv4", port: bridge.port });

    for (const path of ["/", "/events", "/token"]) {
      const { status, body } = await new Promise<{ status?: number; body: string }>((resolve, reject) => {
        get(`http://127.0.0.1:${bridge.port}${path}`, (res) => {
          let body = "";
          res.on("data", (chunk) => (body += chunk));
          res.on("end", () => resolve({ status: res.statusCode, body }));
        }).on("error", reject);
      });
      expect(status).toBe(426);
      expect(body).toBe("");
    }
  });

  it("rejects unknown upgrade paths", async () => {
    const { url } = await setup();
    expect(await upgradeStatus(`${url}/other`)).toBe(404);
  });

  it("refuses unsafe options", async () => {
    await expect(startBridge({ port: 0, token: "short", log: false })).rejects.toThrow(TypeError);
    const token = "a".repeat(64);
    await expect(startBridge({ port: 0, token, allowedViewerOrigins: ["*"], log: false })).rejects.toThrow(
      TypeError,
    );
    await expect(startBridge({ port: 0, token, maxPayloadBytes: 0, log: false })).rejects.toThrow(TypeError);
  });
});

describe("bridge: logging", () => {
  it("19. never writes event contents or the token to stdout/stderr", async () => {
    const captured: string[] = [];
    const capture = (...args: unknown[]) => {
      captured.push(args.map(String).join(" "));
    };
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation(capture);
    }
    const captureWrite = ((chunk: unknown) => {
      captured.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    vi.spyOn(process.stdout, "write").mockImplementation(captureWrite);
    vi.spyOn(process.stderr, "write").mockImplementation(captureWrite);

    let token = "";
    try {
      // `log: undefined` selects the default (stderr) logger.
      const started = await setup({ log: undefined });
      token = started.token;
      const { url, bridge } = started;

      const v = await viewer(url, token);
      const p = await producer(url, token, "MARKER-PROJECT");
      const event = makeEvent({
        projectId: "MARKER-PROJECT",
        path: "MARKER.path",
        input: { secret: "MARKER-INPUT" },
        output: { "MARKER-OUTPUT": 1 },
        error: { message: "MARKER-ERROR", stack: "MARKER-STACK" },
        http: { url: "https://MARKER-URL.example/api/trpc?input=MARKER", method: "POST" },
      });
      p.send({ type: "event", event: { ...event, projectId: "MARKER-OTHER" } });
      p.send({ type: "event", event: { ...event, status: "MARKER-STATUS" } });
      p.send(eventMessage(event));
      await v.client.next();
      v.client.send({ type: "clear", projectId: "MARKER-PROJECT" });
      await v.client.next();

      expect(await upgradeStatus(url, { headers: { Host: "MARKER-HOST.evil.com" } })).toBe(403);
      expect(await upgradeStatus(url, { origin: "https://MARKER-ORIGIN.evil.com" })).toBe(403);
      const intruder = await producer(url, "MARKER-TOKEN".padEnd(64, "0"), "MARKER-PROJECT");
      await intruder.closed;
      const oversized = await producer(url, token, "MARKER-PROJECT");
      oversized.send("MARKER".repeat(100_000));
      await oversized.closed;

      p.ws.close();
      await p.closed;
      await bridge.close();
    } finally {
      vi.restoreAllMocks();
    }

    const output = captured.join("\n");
    // Proves the spies saw the bridge's logging at all.
    expect(output).toContain("viewer connected");
    expect(output).toContain("producer disconnected");
    expect(output).toContain("upgrade rejected (403): host not allowed");
    expect(output).not.toMatch(/MARKER/);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(output).not.toContain(token);
  });
});
