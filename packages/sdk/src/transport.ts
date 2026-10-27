import { readFile } from "node:fs/promises";
import { connect as netConnect, type Socket } from "node:net";
import type WebSocket from "ws";
import { BRIDGE_HOST, type SdkConfig } from "./config";

/** The bridge does not acknowledge hello; this gives a rejection time to arrive before queued events are sent. */
const HELLO_GRACE_MS = 50;
/** A connection that lasted this long resets the backoff. Shorter ones (e.g. a rejected token) keep growing it. */
const STABLE_CONNECTION_MS = 5_000;
/** Stop writing when this much is buffered on the socket; the rest waits in the bounded queue. */
const MAX_BUFFERED_BYTES = 1024 * 1024;
const HANDSHAKE_TIMEOUT_MS = 5_000;
const CLOSE_TIMEOUT_MS = 1_000;
const MAX_TOKEN_LENGTH = 256;
const POLICY_VIOLATION = 1008;

type State = "idle" | "connecting" | "open" | "waiting" | "stopped";

/**
 * Always dials the loopback bridge, whatever host the caller asked for, and
 * unrefs the socket so it never keeps the process alive.
 */
export function connectLoopback(options: { port?: number | string | null }): Socket {
  const socket = netConnect({ host: BRIDGE_HOST, port: Number(options.port) });
  socket.unref();
  return socket;
}

/** The token, or undefined when the file is missing, unreadable or implausible. */
async function readToken(tokenFile: string): Promise<string | undefined> {
  try {
    const token = (await readFile(tokenFile, "utf8")).trim();
    return token !== "" && token.length <= MAX_TOKEN_LENGTH ? token : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One producer connection to the local bridge with a bounded queue, paced
 * sends and backoff reconnects. Methods never throw.
 */
export class Transport {
  private queue: string[] = [];
  private ws: WebSocket | undefined;
  private state: State = "idle";
  private attempt = 0;
  private openedAt = 0;
  private windowStart = 0;
  private windowCount = 0;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private pumpTimer: NodeJS.Timeout | undefined;
  /** Sockets that reached "open"; for tests. */
  opened = 0;

  constructor(
    readonly config: SdkConfig,
    private readonly warn: (reason: string) => void,
  ) {}

  get queueLength(): number {
    return this.queue.length;
  }

  get attempts(): number {
    return this.attempt;
  }

  enqueue(frame: string): void {
    if (this.state === "stopped") return;
    if (this.queue.length >= this.config.queueSize) this.queue.shift();
    this.queue.push(frame);
    if (this.state === "idle") void this.connect();
    else this.pump();
  }

  async close(): Promise<void> {
    this.state = "stopped";
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.pumpTimer);
    this.queue = [];
    const ws = this.ws;
    this.ws = undefined;
    if (!ws || ws.readyState === ws.CLOSED) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        ws.terminate();
        resolve();
      }, CLOSE_TIMEOUT_MS);
      timer.unref();
      ws.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      try {
        ws.close(1000);
      } catch {
        ws.terminate();
      }
    });
  }

  private async connect(): Promise<void> {
    if (this.state === "stopped") return;
    this.state = "connecting";
    try {
      // Read on every attempt so a bridge restart with a new token is picked up.
      const token = await readToken(this.config.tokenFile);
      if (this.isStopped()) return;
      if (token === undefined) {
        this.warn(`bridge not available (no token file at ${this.config.tokenFile})`);
        return this.retry();
      }

      const { WebSocket } = await import("ws");
      if (this.isStopped()) return;
      const ws = new WebSocket(this.config.url, {
        perMessageDeflate: false,
        followRedirects: false,
        handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
        maxPayload: 64 * 1024,
        createConnection: connectLoopback as never,
      });
      this.ws = ws;
      // Failures are handled once, in "close", which always follows "error".
      ws.on("error", () => {});
      ws.on("open", () => this.onOpen(ws, token));
      ws.on("close", (code: number) => this.onClose(ws, code));
    } catch {
      this.warn("bridge not available (transport failed to start)");
      this.retry();
    }
  }

  // A separate method so TypeScript does not narrow `state` across the awaits in connect().
  private isStopped(): boolean {
    return this.state === "stopped";
  }

  private onOpen(ws: WebSocket, token: string): void {
    if (ws !== this.ws) return;
    this.state = "open";
    this.opened++;
    this.openedAt = Date.now();
    this.windowStart = this.openedAt;
    this.windowCount = 0;
    this.send(ws, JSON.stringify({ type: "hello", token, role: "producer", projectId: this.config.projectId }));
    this.schedulePump(HELLO_GRACE_MS);
  }

  private onClose(ws: WebSocket, code: number): void {
    if (ws !== this.ws) return;
    this.ws = undefined;
    clearTimeout(this.pumpTimer);
    this.pumpTimer = undefined;
    if (this.state === "open") {
      if (Date.now() - this.openedAt >= STABLE_CONNECTION_MS) this.attempt = 0;
      if (code === POLICY_VIOLATION) {
        this.warn(`bridge rejected the connection (check the token file at ${this.config.tokenFile})`);
      }
    } else {
      this.warn(`bridge not reachable at ${this.config.url}`);
    }
    this.retry();
  }

  private retry(): void {
    if (this.state === "stopped") return;
    this.state = "waiting";
    const base = Math.min(this.config.backoffMaxMs, this.config.backoffMinMs * 2 ** this.attempt);
    this.attempt = Math.min(this.attempt + 1, 30);
    const delay = base + Math.random() * base * 0.2;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.state !== "waiting") return;
      // Nothing to deliver: stay disconnected until the next event.
      if (this.queue.length === 0) this.state = "idle";
      else void this.connect();
    }, delay);
    this.reconnectTimer.unref();
  }

  private schedulePump(delay: number): void {
    if (this.pumpTimer) return;
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = undefined;
      this.pump();
    }, delay);
    this.pumpTimer.unref();
  }

  private pump(): void {
    const ws = this.ws;
    if (this.state !== "open" || !ws || this.pumpTimer) return;
    const now = Date.now();
    if (now - this.windowStart >= 1_000) {
      this.windowStart = now;
      this.windowCount = 0;
    }
    while (this.queue.length > 0) {
      if (this.windowCount >= this.config.maxSendPerSecond) {
        return this.schedulePump(this.windowStart + 1_000 - now);
      }
      if (ws.bufferedAmount > MAX_BUFFERED_BYTES) return this.schedulePump(50);
      this.send(ws, this.queue.shift()!);
    }
  }

  private send(ws: WebSocket, frame: string): void {
    this.windowCount++;
    // The callback swallows write errors; a failed socket is handled in "close".
    ws.send(frame, () => {});
  }
}
