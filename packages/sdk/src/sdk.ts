import { randomUUID } from "node:crypto";
import {
  isInspectorEnabled,
  resolveMode,
  type InspectorEvent,
  type InspectorMode,
} from "@prashant-rajpurohit/trpc-inspector-core";
import { resolveConfig, resolveProjectId, type SdkConfig, type SdkOptions } from "./config";
import { sanitizeEventWith } from "./sanitize-event";
import { Transport } from "./transport";

/** Shared across module copies, so a Next.js hot reload finds the existing connection. */
const GLOBAL_KEY = Symbol.for("trpc-inspector.sdk");

type SdkState =
  | { enabled: false }
  | { enabled: true; key: string; config: SdkConfig; mode: InspectorMode; transport: Transport };

interface GlobalSlot {
  state?: SdkState;
  /** At most one warning per process. */
  warned?: boolean;
}

function slot(): GlobalSlot {
  const g = globalThis as unknown as Record<symbol, GlobalSlot | undefined>;
  return (g[GLOBAL_KEY] ??= {});
}

function warnOnce(reason: string): void {
  const s = slot();
  if (s.warned) return;
  s.warned = true;
  try {
    console.warn(`[trpc-inspector] ${reason}; events are kept in a bounded memory queue and retried in the background.`);
  } catch {
    // Never fail because of logging.
  }
}

function closeQuietly(state: SdkState | undefined): void {
  if (state?.enabled) state.transport.close().catch(() => {});
}

/**
 * Evaluates the gate and creates (or, for identical config, reuses) the
 * process-wide transport. Calling it again with different config closes the
 * old connection first. Does not connect; the first event does.
 */
export function init(options: SdkOptions = {}): SdkState {
  const s = slot();
  if (!isInspectorEnabled(process.env)) {
    closeQuietly(s.state);
    return (s.state = { enabled: false });
  }
  const config = resolveConfig(options);
  const mode = resolveMode(process.env);
  const key = JSON.stringify({ config, mode });
  if (s.state?.enabled && s.state.key === key) return s.state;
  closeQuietly(s.state);
  return (s.state = { enabled: true, key, config, mode, transport: new Transport(config, warnOnce) });
}

function current(): SdkState {
  return slot().state ?? init();
}

export function emitEvent(event: InspectorEvent): void {
  try {
    const state = current();
    if (!state.enabled) return;
    const clean = sanitizeEventWith(event, state.mode, state.config.projectId);
    if (!clean) return;
    const frame = JSON.stringify({ type: "event", event: clean });
    if (Buffer.byteLength(frame) > state.config.maxFrameBytes) return;
    state.transport.enqueue(frame);
  } catch {
    // Never throw into the host app.
  }
}

export function isEnabled(): boolean {
  try {
    return current().enabled;
  } catch {
    return false;
  }
}

export function newId(): string {
  try {
    return randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
}

/** Closes the connection and drops queued events. A later emitEvent starts over. */
export async function shutdown(): Promise<void> {
  try {
    const s = slot();
    const state = s.state;
    s.state = undefined;
    if (state?.enabled) await state.transport.close();
  } catch {
    // Never throw into the host app.
  }
}

/**
 * Sanitizes `event` for `mode` (default: what the environment allows) and sets
 * the configured project id. Returns null when the result is invalid.
 */
export function sanitizeEvent(event: InspectorEvent, mode?: InspectorMode): InspectorEvent | null {
  try {
    const state = slot().state;
    return sanitizeEventWith(event, mode, state?.enabled ? state.config.projectId : resolveProjectId());
  } catch {
    return null;
  }
}

/** Test-only view of the singleton. */
export function internals() {
  const state = slot().state;
  return {
    enabled: state?.enabled ?? false,
    url: state?.enabled ? state.config.url : undefined,
    transport: state?.enabled ? state.transport : undefined,
  };
}

/** Test-only: closes everything and forgets the singleton, including the warn-once flag. */
export async function resetForTests(): Promise<void> {
  await shutdown();
  delete (globalThis as unknown as Record<symbol, unknown>)[GLOBAL_KEY];
}
