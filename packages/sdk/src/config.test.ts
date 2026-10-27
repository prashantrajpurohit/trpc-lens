import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultTokenFile, packageName, resolveConfig, type SdkOptions } from "./config";
import { runCleanup, tempDir } from "./test-utils";

afterEach(runCleanup);

describe("config", () => {
  it("defaults to port 4567 on 127.0.0.1", () => {
    const config = resolveConfig({}, {});
    expect(config.url).toBe("ws://127.0.0.1:4567");
    expect(config.queueSize).toBe(200);
  });

  it("reads TRPC_INSPECTOR_PORT and ignores invalid values", () => {
    expect(resolveConfig({}, { TRPC_INSPECTOR_PORT: "5000" }).port).toBe(5000);
    for (const bad of ["0", "70000", "abc", "45.5", ""]) {
      expect(resolveConfig({}, { TRPC_INSPECTOR_PORT: bad }).port).toBe(4567);
    }
  });

  it("12a. ignores any host option or env value", () => {
    const options = { host: "10.0.0.5", port: 4600 } as SdkOptions;
    const config = resolveConfig(options, { TRPC_INSPECTOR_HOST: "evil.example.com" });
    expect(config.url).toBe("ws://127.0.0.1:4600");
    expect(JSON.stringify(config)).not.toMatch(/10\.0\.0\.5|evil/);
  });

  it("project id: option, then env, then package.json name, then 'unknown'", () => {
    expect(resolveConfig({ projectId: "opt" }, { TRPC_INSPECTOR_PROJECT: "env" }).projectId).toBe("opt");
    expect(resolveConfig({}, { TRPC_INSPECTOR_PROJECT: "env" }).projectId).toBe("env");
    expect(resolveConfig({ projectId: "x".repeat(150) }, {}).projectId).toHaveLength(100);

    const dir = tempDir();
    expect(packageName(dir)).toBeUndefined();
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "my-app" }));
    expect(packageName(dir)).toBe("my-app");
    writeFileSync(join(dir, "package.json"), "{not json");
    expect(packageName(dir)).toBeUndefined();
  });

  it("uses the bridge's token file location", () => {
    expect(defaultTokenFile({ APPDATA: "C:\\Users\\me\\AppData\\Roaming" }, "win32")).toBe(
      join("C:\\Users\\me\\AppData\\Roaming", "trpc-inspector", "token"),
    );
    expect(defaultTokenFile({ XDG_CONFIG_HOME: "/home/me/.cfg" }, "linux")).toBe(
      join("/home/me/.cfg", "trpc-inspector", "token"),
    );
    // Relative XDG values are ignored, as in the bridge.
    expect(defaultTokenFile({ XDG_CONFIG_HOME: "rel" }, "linux")).toMatch(/\.config[\\/]trpc-inspector[\\/]token$/);
    expect(resolveConfig({ tokenFile: "/custom/token" }, {}).tokenFile).toBe("/custom/token");
  });
});
