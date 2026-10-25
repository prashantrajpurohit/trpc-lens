import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

const TOKEN_PATTERN = /^[0-9a-f]{64}$/;

export interface LoadedToken {
  token: string;
  tokenFile: string;
  /** True when this call generated the token. */
  created: boolean;
}

/**
 * `%APPDATA%\trpc-inspector\token` on Windows, otherwise
 * `$XDG_CONFIG_HOME/trpc-inspector/token` (or `~/.config/...`).
 */
export function defaultTokenFile(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
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

/**
 * Reuses the token in `tokenFile`, or creates one (32 random bytes, hex) with
 * owner-only permissions. Throws if an existing file does not hold a valid
 * token rather than silently replacing it. Never includes the token in errors.
 */
export function loadOrCreateToken(tokenFile: string = defaultTokenFile()): LoadedToken {
  mkdirSync(dirname(tokenFile), { recursive: true, mode: 0o700 });

  const token = randomBytes(32).toString("hex");
  try {
    // "wx" = O_CREAT | O_EXCL: atomic, and refuses to follow a planted symlink.
    writeFileSync(tokenFile, token, { mode: 0o600, flag: "wx" });
    return { token, tokenFile, created: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }

  if (process.platform !== "win32") chmodSync(tokenFile, 0o600);
  const existing = readFileSync(tokenFile, "utf8").trim();
  if (!TOKEN_PATTERN.test(existing)) {
    throw new Error(`Token file ${tokenFile} is malformed. Delete it to generate a new token.`);
  }
  return { token: existing, tokenFile, created: false };
}

/** Constant-time comparison; anything that is not a same-length string is unequal. */
export function tokensEqual(expected: string, received: unknown): boolean {
  if (typeof received !== "string" || expected.length === 0) return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(received, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
