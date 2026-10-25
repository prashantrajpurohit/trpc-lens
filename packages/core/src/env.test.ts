import { describe, expect, it } from "vitest";
import { ALLOWED_ENVS, isInspectorEnabled, resolveMode } from "./env";

describe("isInspectorEnabled", () => {
  it("is true only for an allowed APP_ENV with TRPC_INSPECTOR=1", () => {
    expect(ALLOWED_ENVS).toEqual(["development", "uat"]);
    expect(isInspectorEnabled({ TRPC_INSPECTOR: "1", APP_ENV: "development" })).toBe(true);
    expect(isInspectorEnabled({ TRPC_INSPECTOR: "1", APP_ENV: "uat" })).toBe(true);
  });

  it.each([
    ["production", "production"],
    ["Production", "Production"],
    ["prod", "prod"],
    ["leading whitespace", " uat"],
    ["trailing whitespace", "uat "],
    ["UAT", "UAT"],
    ["empty", ""],
  ])("is false for APP_ENV %s", (_, appEnv) => {
    expect(isInspectorEnabled({ TRPC_INSPECTOR: "1", APP_ENV: appEnv })).toBe(false);
  });

  it("is false when APP_ENV is missing", () => {
    expect(isInspectorEnabled({ TRPC_INSPECTOR: "1" })).toBe(false);
  });

  it("ignores NODE_ENV", () => {
    expect(isInspectorEnabled({ TRPC_INSPECTOR: "1", NODE_ENV: "development" })).toBe(false);
    expect(
      isInspectorEnabled({ TRPC_INSPECTOR: "1", APP_ENV: "uat", NODE_ENV: "production" }),
    ).toBe(true);
  });

  it("is false without TRPC_INSPECTOR=1", () => {
    expect(isInspectorEnabled({ APP_ENV: "uat" })).toBe(false);
    expect(isInspectorEnabled({ APP_ENV: "development", TRPC_INSPECTOR: "true" })).toBe(false);
    expect(isInspectorEnabled({ APP_ENV: "development", TRPC_INSPECTOR: " 1" })).toBe(false);
  });
});

describe("resolveMode", () => {
  it("is full only for development with TRPC_INSPECTOR_MODE=full", () => {
    expect(resolveMode({ APP_ENV: "development", TRPC_INSPECTOR_MODE: "full" })).toBe("full");
  });

  it("is shape for UAT even with TRPC_INSPECTOR_MODE=full", () => {
    expect(resolveMode({ APP_ENV: "uat", TRPC_INSPECTOR_MODE: "full" })).toBe("shape");
  });

  it("is shape for development without a mode or with an unknown one", () => {
    expect(resolveMode({ APP_ENV: "development" })).toBe("shape");
    expect(resolveMode({ APP_ENV: "development", TRPC_INSPECTOR_MODE: "FULL" })).toBe("shape");
    expect(resolveMode({ APP_ENV: "development", TRPC_INSPECTOR_MODE: "yes" })).toBe("shape");
  });

  it("is shape for production with TRPC_INSPECTOR_MODE=full", () => {
    expect(resolveMode({ APP_ENV: "production", TRPC_INSPECTOR_MODE: "full" })).toBe("shape");
  });
});

describe("safety", () => {
  it("both return safely with an empty env", () => {
    expect(isInspectorEnabled({})).toBe(false);
    expect(resolveMode({})).toBe("shape");
  });

  it("neither throws on a hostile env object", () => {
    const hostile = new Proxy({} as Record<string, string | undefined>, {
      get() {
        throw new Error("nope");
      },
    });
    expect(isInspectorEnabled(hostile)).toBe(false);
    expect(resolveMode(hostile)).toBe("shape");
  });
});
