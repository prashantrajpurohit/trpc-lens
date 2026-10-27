import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { connectViewer, downBridge, setupBridge } from "./test-bridge";
import { runCleanup, tempDir } from "./test-utils";

// Runs the built package, as a host app would. Requires `pnpm build` first.
const DIST = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const MARKER = "child-marker-5b7e";

beforeAll(() => {
  if (!existsSync(DIST)) throw new Error("packages/sdk/dist is missing: run `pnpm build` before this test");
});

afterEach(runCleanup);

interface ChildResult {
  code: number | null;
  ms: number;
  output: string;
}

/** Emits 10 events, keeps the process busy for `busyMs`, then lets it end on its own. */
function runChild(port: number, configHome: string, busyMs: number): Promise<ChildResult> {
  const script = `
    import { emitEvent, isEnabled } from ${JSON.stringify(pathToFileURL(DIST).href)};
    if (!isEnabled()) process.exit(3);
    for (let i = 0; i < 10; i++) {
      emitEvent({ id: "child-" + i, projectId: "x", timestamp: Date.now(), path: "p", type: "query",
        source: "server", status: "success", input: { s: ${JSON.stringify(MARKER)} } });
    }
    setTimeout(() => {}, ${busyMs});
  `;
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("TRPC_INSPECTOR")) env[k] = v;
  Object.assign(env, {
    TRPC_INSPECTOR: "1",
    APP_ENV: "development",
    TRPC_INSPECTOR_MODE: "full",
    TRPC_INSPECTOR_PORT: String(port),
    TRPC_INSPECTOR_PROJECT: "exit-test",
    // The default token location on either platform; no tokenFile option is used.
    APPDATA: configHome,
    XDG_CONFIG_HOME: configHome,
  });

  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env, cwd: tempDir() });
    let output = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (output += d));
    const kill = setTimeout(() => child.kill(), 10_000);
    child.on("exit", (code) => {
      clearTimeout(kill);
      resolve({ code, ms: Date.now() - start, output });
    });
  });
}

describe("15. the SDK never keeps the process alive", () => {
  it("exits with the bridge down while a reconnect is pending", async () => {
    const configHome = tempDir();
    const { port } = await downBridge();
    const result = await runChild(port, configHome, 500);
    expect(result.code).toBe(0);
    expect(result.ms).toBeLessThan(3_000);
    // No token file at the default location, so the transport did run and retry.
    expect(result.output).toMatch(/^\[trpc-inspector\] bridge not available \(no token file at .*trpc-inspector.token\)/);
    expect(result.output.trim().split("\n")).toHaveLength(1);
    expect(result.output).not.toContain(MARKER);
  }, 15_000);

  it("exits with an open bridge connection after delivering its events", async () => {
    const configHome = tempDir();
    const b = await setupBridge({ tokenFile: join(configHome, "trpc-inspector", "token") });
    const viewer = await connectViewer(b.url, b.token);
    const result = await runChild(b.port, configHome, 800);
    expect(result.code).toBe(0);
    expect(result.ms).toBeLessThan(3_000);
    expect(result.output).toBe("");
    expect(viewer.events.map((e) => e.id)).toEqual(Array.from({ length: 10 }, (_, i) => `child-${i}`));
    expect(viewer.events[0]).toMatchObject({ projectId: "exit-test", input: { s: MARKER } });
  }, 15_000);
});
