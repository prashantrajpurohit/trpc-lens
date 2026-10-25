#!/usr/bin/env node
import { parseArgs } from "node:util";
import { BRIDGE_HOST, startBridge, type Bridge } from "./server";
import { loadOrCreateToken } from "./token";

const DEFAULT_PORT = 4567;

const USAGE = `Usage: trpc-inspector-bridge [--port ${DEFAULT_PORT}] [--allow-origin chrome-extension://<id>]...

  --port <n>              Port to listen on (127.0.0.1 only). Default ${DEFAULT_PORT}.
  --allow-origin <origin> Origin allowed to connect as a viewer. Repeatable.
                          Also read from TRPC_INSPECTOR_ORIGINS (comma-separated).
  -h, --help              Show this help.`;

function fail(message: string, exitCode: number): never {
  console.error(message);
  process.exit(exitCode);
}

async function main(): Promise<void> {
  let values: { port?: string; "allow-origin"?: string[]; help?: boolean };
  try {
    ({ values } = parseArgs({
      options: {
        port: { type: "string" },
        "allow-origin": { type: "string", multiple: true },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    fail(`${(err as Error).message}\n\n${USAGE}`, 2);
  }

  if (values.help) {
    console.log(USAGE);
    return;
  }

  let port = DEFAULT_PORT;
  if (values.port !== undefined) {
    port = Number(values.port);
    if (!/^\d+$/.test(values.port) || port > 65535) {
      fail(`Invalid --port: must be an integer between 0 and 65535.\n\n${USAGE}`, 2);
    }
  }

  const origins = [
    ...new Set(
      [...(values["allow-origin"] ?? []), ...(process.env.TRPC_INSPECTOR_ORIGINS ?? "").split(",")]
        .map((origin) => origin.trim())
        .filter(Boolean),
    ),
  ];

  const { token, tokenFile } = loadOrCreateToken();

  let bridge: Bridge;
  try {
    bridge = await startBridge({ port, token, allowedViewerOrigins: origins });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
      fail(
        `Port ${port} is already in use. Is another bridge running? Use --port to choose another.`,
        1,
      );
    }
    throw err;
  }

  console.log(
    `trpc-inspector bridge listening on ws://${BRIDGE_HOST}:${bridge.port} ` +
      `(token file: ${tokenFile}, viewer origins: ${origins.length})`,
  );

  let stopping = false;
  const stop = () => {
    if (stopping) process.exit(1);
    stopping = true;
    bridge.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((err: unknown) => {
  fail(`trpc-inspector-bridge: ${err instanceof Error ? err.message : "unexpected error"}`, 1);
});
