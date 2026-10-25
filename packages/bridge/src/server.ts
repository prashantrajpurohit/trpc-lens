import { createServer, STATUS_CODES, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import {
  InspectorEventSchema,
  type InspectorEvent,
} from "@prashant-rajpurohit/trpc-inspector-core";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { z } from "zod";
import { EventStore } from "./store";
import { loadOrCreateToken, tokensEqual } from "./token";

export const BRIDGE_HOST = "127.0.0.1";

const HELLO_TIMEOUT_MS = 3_000;
const MAX_INVALID_MESSAGES = 20;
/** How long a closing peer gets to finish the close handshake. */
const CLOSE_GRACE_MS = 1_000;
/** A viewer that falls this far behind is dropped instead of buffering forever. */
const MAX_VIEWER_BUFFER_BYTES = 64 * 1024 * 1024;

export interface BridgeOptions {
  /** Default 4567. 0 picks a free port. */
  port?: number;
  /** Shared secret. When omitted it is loaded (or created) from `tokenFile`. */
  token?: string;
  /** Defaults to the per-user config location; see `defaultTokenFile`. */
  tokenFile?: string;
  /** Exact `Origin` values allowed to connect as viewers. Default none. */
  allowedViewerOrigins?: string[];
  /** Default 256 KB. */
  maxPayloadBytes?: number;
  /** Default 500. */
  historyPerProject?: number;
  /** Default 20. */
  maxProjects?: number;
  /** Messages per second per connection. Default 200. */
  rateLimitPerSecond?: number;
  /** Concurrent WebSocket connections. Default 64. */
  maxConnections?: number;
  /**
   * Receives operational log lines (roles, counts and rejection reasons only,
   * never event contents). Defaults to stderr; `false` disables logging.
   */
  log?: ((line: string) => void) | false;
}

export interface Bridge {
  port: number;
  address(): AddressInfo;
  close(): Promise<void>;
}

const HelloSchema = z.strictObject({
  type: z.literal("hello"),
  token: z.string().min(1).max(256),
  role: z.enum(["producer", "viewer"]),
  projectId: z.string().min(1).max(100).optional(),
});

const ProducerMessageSchema = z.strictObject({
  type: z.literal("event"),
  event: InspectorEventSchema,
});

const ViewerMessageSchema = z.strictObject({
  type: z.literal("clear"),
  projectId: z.string().min(1).max(100).optional(),
});

type Role = "producer" | "viewer";

function positiveInt(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

function validOrigins(origins: unknown): Set<string> {
  if (!Array.isArray(origins)) throw new TypeError("allowedViewerOrigins must be an array");
  for (const origin of origins) {
    // "null" is what sandboxed frames and file:// pages send; never trust it.
    if (typeof origin !== "string" || !origin || /\s/.test(origin) || origin === "null" || origin === "*") {
      throw new TypeError("allowedViewerOrigins contains an invalid origin");
    }
  }
  return new Set(origins as string[]);
}

function headerCount(req: IncomingMessage, name: string): number {
  let count = 0;
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i]!.toLowerCase() === name) count++;
  }
  return count;
}

function parseJson(data: RawData): unknown {
  try {
    return JSON.parse(data.toString());
  } catch {
    return undefined;
  }
}

export async function startBridge(options: BridgeOptions = {}): Promise<Bridge> {
  const requestedPort = options.port ?? 4567;
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
    throw new TypeError("port must be an integer between 0 and 65535");
  }
  const token = options.token ?? loadOrCreateToken(options.tokenFile).token;
  if (typeof token !== "string" || token.length < 32) {
    throw new TypeError("token must be a string of at least 32 characters");
  }
  const allowedOrigins = validOrigins(options.allowedViewerOrigins ?? []);
  const maxPayload = positiveInt("maxPayloadBytes", options.maxPayloadBytes ?? 256 * 1024);
  const rateLimit = positiveInt("rateLimitPerSecond", options.rateLimitPerSecond ?? 200);
  const maxConnections = positiveInt("maxConnections", options.maxConnections ?? 64);
  const store = new EventStore({
    historyPerProject: positiveInt("historyPerProject", options.historyPerProject ?? 500),
    maxProjects: positiveInt("maxProjects", options.maxProjects ?? 20),
  });
  const log =
    options.log === false
      ? () => {}
      : (options.log ?? ((line: string) => console.error(`[trpc-inspector-bridge] ${line}`)));

  const viewers = new Set<WebSocket>();
  let allowedHosts = new Set<string>();
  let closing: Promise<void> | undefined;

  const server = createServer((_req, res) => {
    // No HTTP endpoints: everything that is not a WebSocket upgrade is refused.
    res.writeHead(426, { Upgrade: "websocket", Connection: "close", "Content-Length": "0" });
    res.end();
  });

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload,
    perMessageDeflate: false,
    clientTracking: true,
  });

  function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
    log(`upgrade rejected (${status}): ${reason}`);
    socket.once("finish", () => socket.destroy());
    socket.end(
      `HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
  }

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on("error", () => socket.destroy());

    if (closing) return rejectUpgrade(socket, 503, "shutting down");
    if (wss.clients.size >= maxConnections) return rejectUpgrade(socket, 503, "too many connections");
    if (req.url !== "/") return rejectUpgrade(socket, 404, "unknown path");

    // DNS-rebinding protection: the browser sends the attacker's hostname here.
    const host = req.headers.host;
    if (headerCount(req, "host") !== 1 || !host || !allowedHosts.has(host)) {
      return rejectUpgrade(socket, 403, "host not allowed");
    }

    if (headerCount(req, "origin") > 1 || req.headers["sec-websocket-origin"] !== undefined) {
      return rejectUpgrade(socket, 403, "ambiguous origin");
    }
    const origin = req.headers.origin;
    if (origin !== undefined && !allowedOrigins.has(origin)) {
      return rejectUpgrade(socket, 403, "origin not allowed");
    }

    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, origin !== undefined));
  });

  function onConnection(ws: WebSocket, hasOrigin: boolean): void {
    let role: Role | undefined;
    let projectId: string | undefined;
    let accepted = 0;
    let invalid = 0;
    let dropped = 0;
    let windowStart = Date.now();
    let windowCount = 0;

    const reject = (code: number, reason: string) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      log(`${role ?? "unauthenticated connection"} rejected: ${reason}`);
      ws.close(code, reason);
      setTimeout(() => ws.terminate(), CLOSE_GRACE_MS).unref();
    };

    const helloTimer = setTimeout(() => reject(1008, "hello timeout"), HELLO_TIMEOUT_MS);

    const countInvalid = () => {
      invalid++;
      if (invalid >= MAX_INVALID_MESSAGES) reject(1008, "too many invalid messages");
    };

    const onHello = (message: unknown) => {
      clearTimeout(helloTimer);
      const hello = HelloSchema.safeParse(message);
      if (!hello.success) return reject(1008, "invalid hello");
      if (!tokensEqual(token, hello.data.token)) return reject(1008, "unauthorized");

      if (hello.data.role === "producer") {
        // Browsers always send Origin, so a page can never act as a producer.
        if (hasOrigin) return reject(1008, "producer must not send an origin");
        if (!hello.data.projectId) return reject(1008, "producer requires a projectId");
        role = "producer";
        projectId = hello.data.projectId;
        log(`producer connected (projects: ${store.projects().length})`);
        return;
      }

      if (!hasOrigin) return reject(1008, "viewer requires an allowed origin");
      role = "viewer";
      viewers.add(ws);
      log(`viewer connected (viewers: ${viewers.size})`);
      ws.send(JSON.stringify({ type: "snapshot", events: store.snapshot(), projects: store.projects() }));
    };

    const onProducerMessage = (message: unknown) => {
      const parsed = ProducerMessageSchema.safeParse(message);
      // One app must not be able to write into another project's history.
      if (!parsed.success || parsed.data.event.projectId !== projectId) return countInvalid();
      if (!store.add(parsed.data.event)) {
        dropped++;
        return;
      }
      accepted++;
      broadcast({ type: "event", event: parsed.data.event });
    };

    const onViewerMessage = (message: unknown) => {
      const parsed = ViewerMessageSchema.safeParse(message);
      if (!parsed.success) return countInvalid();
      store.clear(parsed.data.projectId);
      broadcast(
        parsed.data.projectId === undefined
          ? { type: "cleared" }
          : { type: "cleared", projectId: parsed.data.projectId },
      );
    };

    ws.on("message", (data, isBinary) => {
      if (ws.readyState !== WebSocket.OPEN) return;

      const now = Date.now();
      if (now - windowStart >= 1_000) {
        windowStart = now;
        windowCount = 0;
      }
      if (++windowCount > rateLimit) return reject(1008, "rate limit exceeded");

      if (isBinary) return reject(1003, "binary frames are not accepted");
      const message = parseJson(data);

      if (!role) return onHello(message);
      if (message === undefined) return countInvalid();
      if (role === "producer") onProducerMessage(message);
      else onViewerMessage(message);
    });

    ws.on("error", (err: Error & { code?: string }) => {
      // Only the error code: messages are not guaranteed to be content-free.
      log(`${role ?? "unauthenticated connection"} error: ${err.code ?? "unknown"}`);
    });

    ws.on("close", () => {
      clearTimeout(helloTimer);
      viewers.delete(ws);
      if (role === "producer") {
        log(`producer disconnected (accepted: ${accepted}, invalid: ${invalid}, dropped: ${dropped})`);
      } else if (role === "viewer") {
        log(`viewer disconnected (viewers: ${viewers.size})`);
      }
    });
  }

  function broadcast(message: { type: "event"; event: InspectorEvent } | { type: "cleared"; projectId?: string }) {
    const frame = JSON.stringify(message);
    for (const viewer of viewers) {
      if (viewer.readyState !== WebSocket.OPEN) continue;
      if (viewer.bufferedAmount > MAX_VIEWER_BUFFER_BYTES) {
        log("viewer dropped: too slow");
        viewer.terminate();
        continue;
      }
      viewer.send(frame);
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: BRIDGE_HOST, port: requestedPort, exclusive: true }, () => {
      server.off("error", reject);
      resolve();
    });
  });
  server.on("error", (err: NodeJS.ErrnoException) => log(`server error: ${err.code ?? "unknown"}`));

  const port = (server.address() as AddressInfo).port;
  allowedHosts = new Set([`${BRIDGE_HOST}:${port}`, `localhost:${port}`]);

  async function shutdown(): Promise<void> {
    await Promise.all(
      [...wss.clients].map(
        (client) =>
          new Promise<void>((resolve) => {
            if (client.readyState === WebSocket.CLOSED) return resolve();
            const timer = setTimeout(() => client.terminate(), CLOSE_GRACE_MS);
            client.once("close", () => {
              clearTimeout(timer);
              resolve();
            });
            if (client.readyState === WebSocket.OPEN) client.close(1001, "bridge shutting down");
          }),
      ),
    );
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    store.clear();
  }

  return {
    port,
    address: () => server.address() as AddressInfo,
    close: () => (closing ??= shutdown()),
  };
}
