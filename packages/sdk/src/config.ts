import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** The bridge only ever listens here; there is deliberately no host option. */
export const BRIDGE_HOST = "127.0.0.1";

const DEFAULT_PORT = 4567;
/** The bridge rejects longer project ids. */
const MAX_PROJECT_ID = 100;

type Env = Record<string, string | undefined>;

/** Overrides for tests. Unknown keys (such as `host`) are ignored. */
export interface SdkOptions {
  port?: number;
  projectId?: string;
  tokenFile?: string;
  /** Default 200. When full, the oldest queued event is dropped. */
  queueSize?: number;
  /** Reconnect backoff bounds. Default 500ms to 10s. */
  backoffMinMs?: number;
  backoffMaxMs?: number;
  /**
   * Default 80. The bridge disconnects a connection that sends more than 200
   * messages in its one-second window; two of our windows can overlap one of
   * its windows, so this must stay below half of that.
   */
  maxSendPerSecond?: number;
  /** Events whose frame exceeds this are dropped. Default 256 KB (the bridge's default limit). */
  maxFrameBytes?: number;
}

export interface SdkConfig {
  url: string;
  port: number;
  projectId: string;
  tokenFile: string;
  queueSize: number;
  backoffMinMs: number;
  backoffMaxMs: number;
  maxSendPerSecond: number;
  maxFrameBytes: number;
}

function intInRange(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

/** `name` from `<cwd>/package.json`, or undefined. Never throws. */
export function packageName(cwd: string = process.cwd()): string | undefined {
  try {
    const name = (JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as { name?: unknown }).name;
    return typeof name === "string" && name.trim() !== "" ? name : undefined;
  } catch {
    return undefined;
  }
}

function validProjectId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const id = value.trim().slice(0, MAX_PROJECT_ID);
  return id === "" ? undefined : id;
}

export function resolveProjectId(options: SdkOptions = {}, env: Env = process.env): string {
  return (
    validProjectId(options.projectId) ??
    validProjectId(env.TRPC_INSPECTOR_PROJECT) ??
    validProjectId(packageName()) ??
    "unknown"
  );
}

/**
 * Same location the bridge uses: `%APPDATA%\trpc-inspector\token` on Windows,
 * otherwise `$XDG_CONFIG_HOME/trpc-inspector/token` (or `~/.config/...`).
 */
export function defaultTokenFile(env: Env = process.env, platform: NodeJS.Platform = process.platform): string {
  let base: string;
  if (platform === "win32") {
    base = env.APPDATA && isAbsolute(env.APPDATA) ? env.APPDATA : join(homedir(), "AppData", "Roaming");
  } else {
    // The XDG spec says relative values must be ignored.
    base =
      env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME)
        ? env.XDG_CONFIG_HOME
        : join(homedir(), ".config");
  }
  return join(base, "trpc-inspector", "token");
}

export function resolveConfig(options: SdkOptions = {}, env: Env = process.env): SdkConfig {
  const port = intInRange(options.port ?? env.TRPC_INSPECTOR_PORT, DEFAULT_PORT, 1, 65535);
  const backoffMinMs = intInRange(options.backoffMinMs, 500, 1, 60_000);
  return {
    url: `ws://${BRIDGE_HOST}:${port}`,
    port,
    projectId: resolveProjectId(options, env),
    tokenFile:
      typeof options.tokenFile === "string" && options.tokenFile !== ""
        ? options.tokenFile
        : defaultTokenFile(env),
    queueSize: intInRange(options.queueSize, 200, 1, 100_000),
    backoffMinMs,
    backoffMaxMs: Math.max(backoffMinMs, intInRange(options.backoffMaxMs, 10_000, 1, 600_000)),
    maxSendPerSecond: intInRange(options.maxSendPerSecond, 80, 1, 99),
    maxFrameBytes: intInRange(options.maxFrameBytes, 256 * 1024, 1024, 64 * 1024 * 1024),
  };
}
