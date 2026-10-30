import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startBridge, type Bridge, type BridgeOptions } from "@prashant-rajpurohit/trpc-inspector-bridge";
import type { InspectorEvent } from "@prashant-rajpurohit/trpc-inspector-core";
import { WebSocket } from "ws";
import { onCleanup, tempDir } from "./test-utils";

export const ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Message = { type: string; [key: string]: any };

export interface TestBridge {
  bridge: Bridge;
  port: number;
  url: string;
  token: string;
  tokenFile: string;
  logs: { at: number; line: string }[];
}

/** Starts the real bridge. The token file is created by the bridge itself. */
export async function setupBridge(options: Partial<BridgeOptions> = {}): Promise<TestBridge> {
  const tokenFile = options.tokenFile ?? join(tempDir(), "token");
  const logs: { at: number; line: string }[] = [];
  const bridge = await startBridge({
    port: 0,
    tokenFile,
    allowedViewerOrigins: [ORIGIN],
    log: (line) => logs.push({ at: Date.now(), line }),
    ...options,
  });
  onCleanup(() => bridge.close());
  const token = readFileSync(tokenFile, "utf8").trim();
  return { bridge, port: bridge.port, url: `ws://127.0.0.1:${bridge.port}`, token, tokenFile, logs };
}

/** A port that was free a moment ago, plus a valid token file for it. */
export async function downBridge(): Promise<{ port: number; tokenFile: string }> {
  const tokenFile = join(tempDir(), "token");
  const bridge = await startBridge({ port: 0, tokenFile, log: false });
  const port = bridge.port;
  await bridge.close();
  return { port, tokenFile };
}

export interface Viewer {
  snapshot: Message;
  /** Every event received, snapshot first, then live. Upserts are not collapsed. */
  events: InspectorEvent[];
  next(): Promise<Message>;
}

export async function connectViewer(url: string, token: string): Promise<Viewer> {
  const ws = new WebSocket(url, { origin: ORIGIN });
  onCleanup(() => ws.terminate());
  const queue: Message[] = [];
  const waiters: ((m: Message) => void)[] = [];
  const events: InspectorEvent[] = [];
  ws.on("message", (data) => {
    const message = JSON.parse(data.toString()) as Message;
    if (message.type === "snapshot") events.push(...(message.events as InspectorEvent[]));
    if (message.type === "event") events.push(message.event as InspectorEvent);
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else queue.push(message);
  });
  ws.on("error", () => {});
  const next = () =>
    queue.length > 0 ? Promise.resolve(queue.shift()!) : new Promise<Message>((resolve) => waiters.push(resolve));
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  ws.send(JSON.stringify({ type: "hello", token, role: "viewer" }));
  const snapshot = await next();
  if (snapshot.type !== "snapshot") throw new Error(`expected snapshot, got ${snapshot.type}`);
  return { snapshot, events, next };
}

/** Producers currently connected, according to the bridge's own log lines. */
export function openProducers(logs: { line: string }[]): number {
  const connected = logs.filter((l) => l.line.startsWith("producer connected")).length;
  const disconnected = logs.filter((l) => l.line.startsWith("producer disconnected")).length;
  return connected - disconnected;
}
