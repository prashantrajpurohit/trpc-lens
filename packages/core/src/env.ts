export const ALLOWED_ENVS = ["development", "uat"] as const;

export type InspectorMode = "full" | "shape";

type Env = Record<string, string | undefined>;

/** `process.env`, or an empty env where `process` does not exist (browsers, edge). */
function processEnv(): Env {
  const proc = (globalThis as { process?: { env?: Env } }).process;
  return proc?.env ?? {};
}

/**
 * True only when `TRPC_INSPECTOR` is exactly "1" and `APP_ENV` is exactly one
 * of `ALLOWED_ENVS`. Fails closed: anything else, including production, a
 * missing value, other casing or whitespace, is false. `NODE_ENV` is ignored
 * because `next build` sets it to "production" on every deployed environment.
 * Never throws.
 */
export function isInspectorEnabled(env?: Env): boolean {
  try {
    const e = env ?? processEnv();
    const appEnv = e.APP_ENV;
    return (
      e.TRPC_INSPECTOR === "1" &&
      typeof appEnv === "string" &&
      (ALLOWED_ENVS as readonly string[]).includes(appEnv)
    );
  } catch {
    return false;
  }
}

/**
 * "full" only when `APP_ENV` is "development" and `TRPC_INSPECTOR_MODE` is
 * "full". Every other case, UAT included, is "shape". Never throws.
 */
export function resolveMode(env?: Env): InspectorMode {
  try {
    const e = env ?? processEnv();
    return e.APP_ENV === "development" && e.TRPC_INSPECTOR_MODE === "full" ? "full" : "shape";
  } catch {
    return "shape";
  }
}
