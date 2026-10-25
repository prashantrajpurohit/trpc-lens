import { describe, expect, it } from "vitest";
import { REDACTED, sanitize, sanitizeUrl } from "./sanitize";
import { InspectorEventSchema } from "./schema";

const full = { mode: "full" } as const;

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
    }, full);
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
    const { value } = sanitize({ ssn: "1", password: "p" }, { ...full, sensitive: /ssn/i });
    expect(value).toEqual({ ssn: REDACTED, password: "p" });
  });

  it("replaces circular references with [Circular] without throwing", () => {
    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    a.list = [a];
    const { value } = sanitize(a, full);
    expect(value).toEqual({ name: "a", self: "[Circular]", list: ["[Circular]"] });
  });

  it("serializes shared non-circular references normally", () => {
    const shared = { x: 1 };
    const { value } = sanitize({ a: shared, b: shared }, full);
    expect(value).toEqual({ a: { x: 1 }, b: { x: 1 } });
  });

  it("returns [Payload too large] for a huge payload", () => {
    const huge = { rows: Array.from({ length: 50 }, () => "x".repeat(1999)) };
    const result = sanitize(huge, full);
    expect(result).toEqual({ value: "[Payload too large]", truncated: true });
  });

  it("truncates long strings, long arrays and deep objects", () => {
    const long = sanitize("y".repeat(3000), full);
    expect(long.truncated).toBe(true);
    expect(long.value).toBe("y".repeat(2000) + "…[truncated]");

    const arr = sanitize(Array.from({ length: 80 }, (_, i) => i), full);
    expect(arr.truncated).toBe(true);
    expect(arr.value).toHaveLength(50);

    const deep = sanitize({ a: { b: { c: 1 } } }, { ...full, maxDepth: 2 });
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
    }, full);
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
    const out = sanitizeUrl(
      `https://user:pass@api.example.com/api/trpc/user.login?batch=1&${query}`,
      full,
    );
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
    const out = sanitizeUrl(`/api/trpc/post.list?${query}`, full);
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

describe("shape mode", () => {
  const secrets = ["ada@example.com", "hunter2", "31337", "4242", "s3cr3t-key"];
  const payload = {
    email: "ada@example.com",
    age: 31337,
    nested: { pin: 4242, credentials: { apiKey: "s3cr3t-key" }, password: "hunter2" },
  };

  it("keeps structure and keys but no original values", () => {
    const { value, truncated } = sanitize(payload, { mode: "shape" });
    expect(value).toEqual({
      email: "string(15)",
      age: "number",
      nested: { pin: "number", credentials: REDACTED, password: REDACTED },
    });
    expect(truncated).toBe(false);
    const json = JSON.stringify(value);
    for (const secret of secrets) expect(json).not.toContain(secret);
  });

  it("is the default mode", () => {
    expect(sanitize(payload)).toEqual(sanitize(payload, { mode: "shape" }));
    expect(sanitizeUrl("/api/trpc/a.b?page=2")).toBe(sanitizeUrl("/api/trpc/a.b?page=2", { mode: "shape" }));
    expect(sanitize("hello").value).toBe("string(5)");
  });

  it("treats any mode other than full as shape", () => {
    const { value } = sanitize("hello", { mode: "FULL" as unknown as "full" });
    expect(value).toBe("string(5)");
  });

  it("describes every primitive leaf", () => {
    const { value } = sanitize({
      s: "abc",
      n: 1.5,
      b: true,
      big: 123n,
      nul: null,
      undef: undefined,
      when: new Date("2024-01-02T03:04:05.000Z"),
      sym: Symbol("secret"),
      fn: () => 1,
      err: new TypeError("leaky message"),
    });
    expect(value).toEqual({
      s: "string(3)",
      n: "number",
      b: "boolean",
      big: "bigint",
      nul: null,
      undef: undefined,
      when: "date",
      sym: "symbol",
      fn: "[Function]",
      err: { name: "string(9)", message: "string(13)" },
    });
    expect(Object.hasOwn(value as object, "undef")).toBe(true);
    expect(JSON.stringify(value)).not.toContain("leaky");
  });

  it("caps arrays with a total marker and sets truncated", () => {
    const { value, truncated } = sanitize(
      Array.from({ length: 5 }, (_, i) => `item-${i}`),
      { maxArray: 2 },
    );
    expect(value).toEqual(["string(6)", "string(6)", "…(5 total)"]);
    expect(truncated).toBe(true);

    const short = sanitize([1, 2], { maxArray: 2 });
    expect(short).toEqual({ value: ["number", "number"], truncated: false });
  });

  it("still applies depth, circular and size limits", () => {
    expect(sanitize({ a: { b: { c: 1 } } }, { maxDepth: 2 })).toEqual({
      value: { a: { b: "[MaxDepth]" } },
      truncated: true,
    });

    const a: Record<string, unknown> = { name: "a" };
    a.self = a;
    expect(sanitize(a).value).toEqual({ name: "string(1)", self: "[Circular]" });

    expect(sanitize({ a: "x", b: "y" }, { maxBytes: 10 })).toEqual({
      value: "[Payload too large]",
      truncated: true,
    });
  });

  it("does not truncate a long string, only describes it", () => {
    expect(sanitize("y".repeat(3000))).toEqual({ value: "string(3000)", truncated: false });
  });

  it("sanitizeUrl keeps the procedure path and no param or input values", () => {
    const input = JSON.stringify({ 0: { email: "ada@example.com", password: "hunter2", pin: 4242 } });
    const raw =
      `https://user:pass@api.example.com/api/trpc/user.login,post.byId` +
      `?batch=1&input=${encodeURIComponent(input)}&token=abc123&page=31337&q=s3cr3t-key`;
    const out = sanitizeUrl(raw, { mode: "shape" });
    const url = new URL(out);

    expect(url.pathname).toBe("/api/trpc/user.login,post.byId");
    expect(url.username).toBe("");
    expect(url.password).toBe("");
    expect(url.searchParams.get("batch")).toBe("string(1)");
    expect(url.searchParams.get("page")).toBe("string(5)");
    expect(url.searchParams.get("q")).toBe("string(10)");
    expect(url.searchParams.get("token")).toBe(REDACTED);
    expect(inputOf(out)).toEqual({ 0: { email: "string(15)", password: REDACTED, pin: "number" } });

    const decoded = decodeURIComponent(out);
    for (const secret of [...secrets, "abc123", "user:pass"]) expect(decoded).not.toContain(secret);
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
