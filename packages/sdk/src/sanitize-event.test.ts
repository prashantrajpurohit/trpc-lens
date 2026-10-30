import type { InspectorEvent } from "@prashant-rajpurohit/trpc-inspector-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scrubMessage, sanitizeEventWith } from "./sanitize-event";
import { sanitizeEvent } from "./sdk";
import { makeEvent } from "./test-utils";

afterEach(() => {
  vi.unstubAllEnvs();
});

const DEV = { APP_ENV: "development" };
const UAT = { APP_ENV: "uat" };

function errorEvent(): InspectorEvent {
  return makeEvent({
    status: "error",
    error: {
      code: "BAD_REQUEST",
      message: 'User "Jane Roe" (jane.roe@example.com) has id 12345678',
      stack: "Error: boom\n    at handler (/srv/app/router.ts:10:5)",
      issues: [{ code: "invalid_type", path: ["user", 0, "email"], message: "Expected string, received 'leaked-value'" }],
    },
  });
}

describe("sanitizeEvent", () => {
  it("6a. full mode keeps values but redacts sensitive keys", () => {
    const out = sanitizeEventWith(
      makeEvent({ input: { username: "alice", password: "hunter2" }, output: { ok: true } }),
      "full",
      "proj",
      DEV,
    );
    expect(out?.input).toEqual({ username: "alice", password: "[REDACTED]" });
    expect(out?.output).toEqual({ ok: true });
    expect(JSON.stringify(out)).not.toContain("hunter2");
  });

  it("6b. shape mode leaves no original string or number value", () => {
    const originals = [
      "shape-user@example.com",
      "9876543",
      "shape-flag-value",
      "output-value-xyz",
      "13579",
      "url-input-value",
      "url-param-value",
      "quoted-msg-value",
      "meta-value-abc",
      "leaked-value",
    ];
    const event = makeEvent({
      input: { email: "shape-user@example.com", count: 9876543, nested: { flag: "shape-flag-value" } },
      output: [{ note: "output-value-xyz", n: 13579 }],
      http: {
        url: `/api/trpc/user.get?input=${encodeURIComponent(JSON.stringify({ q: "url-input-value" }))}&foo=url-param-value`,
        method: "GET",
      },
      error: {
        message: 'failed for "quoted-msg-value"',
        issues: [{ code: "custom", path: ["q"], message: "got leaked-value" }],
      },
      meta: { note: "meta-value-abc" },
    });
    const out = sanitizeEventWith(event, "shape", "proj", DEV);
    expect(out).not.toBeNull();
    const json = JSON.stringify(out);
    for (const value of originals) expect(json).not.toContain(value);
    expect(out?.input).toEqual({ email: "string(22)", count: "number", nested: { flag: "string(16)" } });
  });

  it("defaults the mode from the environment", () => {
    const event = makeEvent({ input: { name: "alice" } });
    vi.stubEnv("APP_ENV", "development");
    vi.stubEnv("TRPC_INSPECTOR_MODE", "full");
    expect(sanitizeEvent(event)?.input).toEqual({ name: "alice" });
    vi.stubEnv("TRPC_INSPECTOR_MODE", "");
    expect(sanitizeEvent(event)?.input).toEqual({ name: "string(5)" });
  });

  it("7. UAT forces shape mode even with TRPC_INSPECTOR_MODE=full or an explicit 'full'", () => {
    vi.stubEnv("APP_ENV", "uat");
    vi.stubEnv("TRPC_INSPECTOR_MODE", "full");
    const event = makeEvent({ input: { name: "alice" } });
    expect(sanitizeEvent(event)?.input).toEqual({ name: "string(5)" });
    expect(sanitizeEvent(event, "full")?.input).toEqual({ name: "string(5)" });
  });

  it("8. keeps the stack only in development + full", () => {
    expect(sanitizeEventWith(errorEvent(), "full", "p", DEV)?.error?.stack).toContain("router.ts");
    expect(sanitizeEventWith(errorEvent(), "shape", "p", DEV)?.error).not.toHaveProperty("stack");
    expect(sanitizeEventWith(errorEvent(), "full", "p", UAT)?.error).not.toHaveProperty("stack");
    expect(sanitizeEventWith(errorEvent(), "shape", "p", UAT)?.error).not.toHaveProperty("stack");
  });

  it("9. scrubs emails, quoted text and long digit runs from messages in shape mode", () => {
    expect(scrubMessage(`User "Jane Roe" (jane.roe@example.com) has id 12345678, code 12345`)).toBe(
      "User […] ([…]) has id […], code 12345",
    );
    expect(scrubMessage("value 'secret' and `tick` and “curly”")).toBe("value […] and […] and […]");

    const out = sanitizeEventWith(errorEvent(), "shape", "p", DEV);
    expect(out?.error?.message).not.toMatch(/Jane|jane\.roe|12345678/);
    expect(out?.error?.code).toBe("BAD_REQUEST");
    // Issue paths and codes only; the message quoting the value is gone.
    expect(out?.error?.issues).toEqual([{ code: "invalid_type", path: ["user", 0, "email"] }]);

    const full = sanitizeEventWith(errorEvent(), "full", "p", DEV);
    expect(full?.error?.message).toBe('User "Jane Roe" (jane.roe@example.com) has id 12345678');
  });

  it("10. returns null for an invalid event", () => {
    expect(sanitizeEventWith({ id: 123 } as unknown as InspectorEvent, "shape", "p", DEV)).toBeNull();
    expect(sanitizeEventWith(makeEvent({ status: "done" as never }), "full", "p", DEV)).toBeNull();
    expect(sanitizeEventWith(null as unknown as InspectorEvent, "full", "p", DEV)).toBeNull();
    // A getter that throws is contained.
    const hostile = makeEvent();
    Object.defineProperty(hostile, "input", { enumerable: true, get: () => { throw new Error("x"); } });
    expect(sanitizeEventWith(hostile, "full", "p", DEV)).toBeNull();
  });

  it("never mutates the caller's event and overrides projectId", () => {
    const event = errorEvent();
    event.input = { password: "hunter2", list: [1, 2, 3] };
    event.http = { url: "/api/trpc/x?token=abc", method: "GET" };
    const before = structuredClone(event);
    const out = sanitizeEventWith(event, "shape", "configured-project", DEV);
    expect(event).toEqual(before);
    expect(out?.projectId).toBe("configured-project");
    expect(out).not.toBe(event);
  });

  it("sets truncated when input or output was truncated", () => {
    const out = sanitizeEventWith(makeEvent({ output: { big: "x".repeat(5_000) } }), "full", "p", DEV);
    expect(out?.truncated).toBe(true);
  });

  it("drops meta that is not a record after sanitizing", () => {
    // Over core's 50 KB cap, so sanitize returns a placeholder string instead of a record.
    const meta = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, "x".repeat(2_000)]));
    const out = sanitizeEventWith(makeEvent({ meta }), "full", "p", DEV);
    expect(out).not.toBeNull();
    expect(out).not.toHaveProperty("meta");
  });
});
