import { describe, expect, it } from "vitest";
import { REDACTED, sanitize, sanitizeUrl } from "./sanitize";
import { InspectorEventSchema } from "./schema";

/** Decodes the `input` query param of a sanitized URL back into an object. */
function inputOf(url: string): unknown {
  const parsed = new URL(url, "http://x.invalid");
  return JSON.parse(parsed.searchParams.get("input")!);
}

describe("sanitize", () => {
  it("redacts sensitive keys at any depth and keeps the rest", () => {
    const { value, truncated } = sanitize({
      name: "ada",
      user: {
        email: "ada@example.com",
        password: "hunter2",
        auth: { accessToken: "abc", apiKey: "k", note: "keep" },
      },
      headers: { Authorization: "Bearer x", Cookie: "sid=1" },
    });
    expect(value).toEqual({
      name: "ada",
      user: {
        email: "ada@example.com",
        password: REDACTED,
        auth: { accessToken: REDACTED, apiKey: REDACTED, note: "keep" },
      },
      headers: { Authorization: REDACTED, Cookie: REDACTED },
    });
    expect(truncated).toBe(false);
  });

  it("accepts a custom sensitive pattern", () => {
    const { value } = sanitize({ ssn: "1", password: "p" }, { sensitive: /ssn/i });
    expect(value).toEqual({ ssn: REDACTED, password: "p" });
  });

  it("replaces circular references with [Circular] without throwing", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    a.list = [a];
    const { value } = sanitize(a);
    expect(value).toEqual({ name: "a", self: "[Circular]", list: ["[Circular]"] });
  });

  it("serializes shared non-circular references normally", () => {
    const shared = { x: 1 };
    const { value } = sanitize({ a: shared, b: shared });
    expect(value).toEqual({ a: { x: 1 }, b: { x: 1 } });
  });

  it("returns [Payload too large] for a huge payload", () => {
    const huge = { rows: Array.from({ length: 50 }, () => "x".repeat(1999)) };
    const result = sanitize(huge);
    expect(result).toEqual({ value: "[Payload too large]", truncated: true });
  });

  it("truncates long strings, long arrays and deep objects", () => {
    const long = sanitize("y".repeat(3000));
    expect(long.truncated).toBe(true);
    expect(long.value).toBe("y".repeat(2000) + "…[truncated]");

    const arr = sanitize(Array.from({ length: 80 }, (_, i) => i));
    expect(arr.truncated).toBe(true);
    expect(arr.value).toHaveLength(50);

    const deep = sanitize({ a: { b: { c: 1 } } }, { maxDepth: 2 });
    expect(deep).toEqual({ value: { a: { b: "[MaxDepth]" } }, truncated: true });
  });

  it("converts bigint, functions, symbols, dates and errors without throwing", () => {
    const err = new TypeError("boom");
    const { value, truncated } = sanitize({
      big: 123n,
      fn: () => 1,
      sym: Symbol("s"),
      when: new Date("2024-01-02T03:04:05.000Z"),
      bad: new Date("nope"),
      err,
    });
    expect(value).toEqual({
      big: "123n",
      fn: "[Function]",
      sym: "Symbol(s)",
      when: "2024-01-02T03:04:05.000Z",
      bad: "Invalid Date",
      err: { name: "TypeError", message: "boom" },
    });
    expect(truncated).toBe(false);
  });

  it("returns [Unserializable] instead of throwing on hostile getters", () => {
    const hostile = {
      get boom() {
        throw new Error("nope");
      },
    };
    expect(sanitize(hostile)).toEqual({ value: "[Unserializable]", truncated: true });
  });
});

describe("sanitizeUrl", () => {
  const input = JSON.stringify({ 0: { email: "a@b.co", password: "hunter2" } });
  const query = `input=${encodeURIComponent(input)}&token=abc123&page=2`;

  it("cleans an absolute tRPC GET URL", () => {
    const out = sanitizeUrl(`https://user:pass@api.example.com/api/trpc/user.login?batch=1&${query}`);
    const url = new URL(out);

    expect(url.origin).toBe("https://api.example.com");
    expect(url.username).toBe("");
    expect(url.password).toBe("");
    expect(out).not.toContain("user:pass@");
    expect(url.pathname).toBe("/api/trpc/user.login");
    expect(url.searchParams.get("token")).toBe(REDACTED);
    expect(url.searchParams.get("page")).toBe("2");
    expect(url.searchParams.get("batch")).toBe("1");
    expect(inputOf(out)).toEqual({ 0: { email: "a@b.co", password: REDACTED } });
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("abc123");
  });

  it("keeps relative URLs relative", () => {
    const out = sanitizeUrl(`/api/trpc/post.list?${query}`);
    expect(out.startsWith("/api/trpc/post.list?")).toBe(true);
    expect(out).not.toContain("relative.invalid");
    expect(inputOf(out)).toEqual({ 0: { email: "a@b.co", password: REDACTED } });
    expect(new URL(out, "http://x.invalid").searchParams.get("page")).toBe("2");
  });

  it("marks an unparseable input param", () => {
    const out = sanitizeUrl("/api/trpc/x?input=%7Bnot-json");
    expect(new URL(out, "http://x.invalid").searchParams.get("input")).toBe("[unparseable]");
  });

  it("returns [invalid-url] for invalid input", () => {
    expect(sanitizeUrl("http://")).toBe("[invalid-url]");
    expect(sanitizeUrl(42 as unknown as string)).toBe("[invalid-url]");
  });
});

describe("InspectorEventSchema", () => {
  it("accepts a server event with no http field", () => {
    const result = InspectorEventSchema.safeParse({
      id: "evt_1",
      projectId: "proj_1",
      timestamp: Date.now(),
      path: "user.byId",
      type: "query",
      source: "server",
      status: "success",
      input: { id: 1 },
      output: { id: 1, name: "ada" },
      durationMs: 4,
    });
    expect(result.success).toBe(true);
  });

  it("rejects an incomplete event", () => {
    expect(InspectorEventSchema.safeParse({ id: "1" }).success).toBe(false);
  });
});
