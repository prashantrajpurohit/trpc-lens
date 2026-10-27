import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InspectorEvent } from "@prashant-rajpurohit/trpc-inspector-core";

// Must not import "ws" or the bridge: gate.test.ts spies on ws being loaded.

const cleanup: (() => unknown)[] = [];

export function onCleanup(fn: () => unknown): void {
  cleanup.push(fn);
}

/** Call from afterEach. */
export async function runCleanup(): Promise<void> {
  for (const fn of cleanup.splice(0).reverse()) await fn();
}

export function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "trpc-sdk-"));
  onCleanup(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export async function waitFor(condition: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await sleep(10);
  }
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let seq = 0;
export function makeEvent(overrides: Partial<InspectorEvent> = {}): InspectorEvent {
  return {
    id: `evt-${++seq}`,
    projectId: "caller-supplied",
    timestamp: 1_700_000_000_000,
    path: "user.get",
    type: "query",
    source: "server",
    status: "pending",
    ...overrides,
  };
}
