import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultTokenFile, loadOrCreateToken, tokensEqual } from "./token";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "trpc-bridge-token-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("loadOrCreateToken", () => {
  it("creates a 32-byte hex token, creating missing directories", () => {
    const tokenFile = join(tempDir(), "nested", "trpc-inspector", "token");
    const { token, created } = loadOrCreateToken(tokenFile);
    expect(created).toBe(true);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reuses an existing token", () => {
    const tokenFile = join(tempDir(), "token");
    const first = loadOrCreateToken(tokenFile);
    const second = loadOrCreateToken(tokenFile);
    expect(second.created).toBe(false);
    expect(second.token).toBe(first.token);
  });

  it("refuses a malformed token file without echoing its contents", () => {
    const tokenFile = join(tempDir(), "token");
    writeFileSync(tokenFile, "not-a-token-SECRETISH");
    expect(() => loadOrCreateToken(tokenFile)).toThrow(/malformed/);
    expect(() => loadOrCreateToken(tokenFile)).not.toThrow(/SECRETISH/);
  });

  // Test 18. POSIX mode bits do not apply on Windows (the file inherits the
  // user profile's ACL there), so this assertion only runs elsewhere.
  it.skipIf(process.platform === "win32")("creates the file 0600 and the directory 0700", () => {
    const dir = join(tempDir(), "trpc-inspector");
    const tokenFile = join(dir, "token");
    loadOrCreateToken(tokenFile);
    expect(statSync(tokenFile).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });
});

describe("defaultTokenFile", () => {
  const base = tmpdir();

  it("uses %APPDATA% on Windows", () => {
    expect(defaultTokenFile({ APPDATA: base }, "win32")).toBe(join(base, "trpc-inspector", "token"));
  });

  it("uses $XDG_CONFIG_HOME elsewhere", () => {
    expect(defaultTokenFile({ XDG_CONFIG_HOME: base }, "linux")).toBe(
      join(base, "trpc-inspector", "token"),
    );
  });

  it("falls back to ~/.config, ignoring a relative XDG_CONFIG_HOME", () => {
    const expected = join(homedir(), ".config", "trpc-inspector", "token");
    expect(defaultTokenFile({}, "darwin")).toBe(expected);
    expect(defaultTokenFile({ XDG_CONFIG_HOME: "relative/dir" }, "linux")).toBe(expected);
  });
});

describe("tokensEqual", () => {
  const token = "a".repeat(64);

  it("accepts only an identical string", () => {
    expect(tokensEqual(token, "a".repeat(64))).toBe(true);
    expect(tokensEqual(token, "b".repeat(64))).toBe(false);
    expect(tokensEqual(token, "a".repeat(63))).toBe(false);
    expect(tokensEqual(token, "")).toBe(false);
    expect(tokensEqual(token, undefined)).toBe(false);
    expect(tokensEqual(token, 42)).toBe(false);
    expect(tokensEqual("", "")).toBe(false);
  });
});
