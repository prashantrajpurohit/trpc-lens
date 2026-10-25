export const REDACTED = "[REDACTED]";

export interface SanitizeOptions {
  maxDepth?: number;
  maxString?: number;
  maxArray?: number;
  maxBytes?: number;
  /** Object keys matching this pattern have their values redacted. */
  sensitive?: RegExp;
}

const DEFAULT_SENSITIVE =
  /pass(word)?|token|secret|authorization|cookie|api[-_]?key|session|credential|private/i;

const SENSITIVE_PARAM = /token|key|auth|secret|pass|session|cookie|signature|sig/i;

const TRUNCATED_SUFFIX = "…[truncated]";

function matches(re: RegExp, s: string): boolean {
  // A caller-supplied /g or /y regex keeps state between test() calls.
  re.lastIndex = 0;
  return re.test(s);
}

/**
 * Makes an arbitrary value safe to serialize and ship: redacts sensitive keys,
 * breaks cycles, and bounds depth, string length, array length and total size.
 * Never throws.
 */
export function sanitize(
  value: unknown,
  opts: SanitizeOptions = {},
): { value: unknown; truncated: boolean } {
  const maxDepth = opts.maxDepth ?? 6;
  const maxString = opts.maxString ?? 2000;
  const maxArray = opts.maxArray ?? 50;
  const maxBytes = opts.maxBytes ?? 50_000;
  const sensitive = opts.sensitive ?? DEFAULT_SENSITIVE;

  let truncated = false;
  // Objects on the current path only, so shared (non-circular) references
  // are still serialized each time they appear.
  const ancestors = new Set<object>();

  const walk = (v: unknown, depth: number): unknown => {
    switch (typeof v) {
      case "string":
        if (v.length > maxString) {
          truncated = true;
          return v.slice(0, maxString) + TRUNCATED_SUFFIX;
        }
        return v;
      case "bigint":
        return `${v}n`;
      case "function":
        return "[Function]";
      case "symbol":
        return v.toString();
      case "object":
        break;
      default:
        return v;
    }
    if (v === null) return null;

    if (v instanceof Date) {
      return Number.isNaN(v.getTime()) ? "Invalid Date" : v.toISOString();
    }
    if (v instanceof Error) {
      return { name: v.name, message: v.message };
    }
    if (ancestors.has(v)) return "[Circular]";
    if (depth >= maxDepth) {
      truncated = true;
      return "[MaxDepth]";
    }

    ancestors.add(v);
    try {
      if (Array.isArray(v)) {
        if (v.length > maxArray) truncated = true;
        return v.slice(0, maxArray).map((item) => walk(item, depth + 1));
      }
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(v)) {
        out[key] = matches(sensitive, key)
          ? REDACTED
          : walk((v as Record<string, unknown>)[key], depth + 1);
      }
      return out;
    } finally {
      ancestors.delete(v);
    }
  };

  try {
    const result = walk(value, 0);
    const json = JSON.stringify(result);
    if (json !== undefined && new TextEncoder().encode(json).length > maxBytes) {
      return { value: "[Payload too large]", truncated: true };
    }
    return { value: result, truncated };
  } catch {
    return { value: "[Unserializable]", truncated: true };
  }
}

const ABSOLUTE_URL = /^[a-z][a-z\d+.-]*:/i;
const RELATIVE_BASE = "http://relative.invalid";

/**
 * Strips credentials and sensitive query params from a URL, and sanitizes the
 * JSON `input` param that tRPC GET requests carry. Never throws.
 */
export function sanitizeUrl(raw: string, opts?: SanitizeOptions): string {
  try {
    if (typeof raw !== "string") return "[invalid-url]";
    const absolute = ABSOLUTE_URL.test(raw);
    const url = absolute ? new URL(raw) : new URL(raw, RELATIVE_BASE);

    url.username = "";
    url.password = "";

    if (url.search) {
      const params = new URLSearchParams();
      for (const [name, value] of url.searchParams) {
        if (name === "input") {
          let clean: string;
          try {
            clean = JSON.stringify(sanitize(JSON.parse(value), opts).value);
          } catch {
            clean = "[unparseable]";
          }
          params.append(name, clean);
        } else {
          params.append(name, SENSITIVE_PARAM.test(name) ? REDACTED : value);
        }
      }
      url.search = params.toString();
    }

    return absolute ? url.toString() : url.pathname + url.search;
  } catch {
    return "[invalid-url]";
  }
}
