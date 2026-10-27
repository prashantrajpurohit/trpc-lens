import {
  InspectorEventSchema,
  resolveMode,
  sanitize,
  sanitizeUrl,
  type InspectorEvent,
  type InspectorMode,
} from "@prashant-rajpurohit/trpc-inspector-core";

type Env = Record<string, string | undefined>;

const SCRUBBED = "[…]";
const QUOTED = /"[^"]*"|'[^']*'|`[^`]*`|“[^”]*”|‘[^’]*’/g;
const EMAIL = /[^\s@()<>[\]{},;:"']+@[^\s@()<>[\]{},;:"']+/g;
const LONG_DIGITS = /\d{6,}/g;

const MAX_ISSUES = 50;
const MAX_PATH_SEGMENTS = 20;
const MAX_SEGMENT_LENGTH = 100;

/** Replaces quoted substrings, email addresses and 6+ digit runs with `[…]`. */
export function scrubMessage(message: string): string {
  return message.replace(QUOTED, SCRUBBED).replace(EMAIL, SCRUBBED).replace(LONG_DIGITS, SCRUBBED);
}

/**
 * No mode given: whatever the environment allows. An explicit "full" is still
 * only honoured in development, so a caller cannot widen what UAT exposes.
 */
function effectiveMode(mode: unknown, env: Env): InspectorMode {
  if (mode === undefined) return resolveMode(env);
  return mode === "full" && env.APP_ENV === "development" ? "full" : "shape";
}

/** Keeps each issue's `code` and `path` only; messages can quote the rejected value. */
function issueShape(issues: unknown): unknown {
  if (!Array.isArray(issues)) return sanitize(issues, { mode: "shape" }).value;
  return issues.slice(0, MAX_ISSUES).map((issue: unknown) => {
    if (typeof issue !== "object" || issue === null) return sanitize(issue, { mode: "shape" }).value;
    const { code, path } = issue as { code?: unknown; path?: unknown };
    const out: { code?: string; path?: (string | number)[] } = {};
    if (typeof code === "string") out.code = code.slice(0, MAX_SEGMENT_LENGTH);
    if (Array.isArray(path)) {
      out.path = path
        .slice(0, MAX_PATH_SEGMENTS)
        .map((seg: unknown) =>
          typeof seg === "number" ? seg : typeof seg === "string" ? seg.slice(0, MAX_SEGMENT_LENGTH) : typeof seg,
        );
    }
    return out;
  });
}

/**
 * Returns a sanitized copy of `event` with `projectId` replaced, or null when
 * the result is not a valid InspectorEvent. Never mutates `event`. Never throws.
 */
export function sanitizeEventWith(
  event: InspectorEvent,
  mode: InspectorMode | undefined,
  projectId: string,
  env: Env = process.env,
): InspectorEvent | null {
  try {
    if (typeof event !== "object" || event === null) return null;
    const m = effectiveMode(mode, env);
    const opts = { mode: m };
    const out: Record<string, unknown> = { ...event, projectId };

    let truncated = false;
    for (const key of ["input", "output", "meta"] as const) {
      if (event[key] === undefined) continue;
      const result = sanitize(event[key], opts);
      out[key] = result.value;
      truncated ||= result.truncated;
    }
    // `meta` must stay a record; a size-capped placeholder string would fail validation.
    if (out.meta !== undefined && (typeof out.meta !== "object" || out.meta === null || Array.isArray(out.meta))) {
      delete out.meta;
    }
    if (truncated) out.truncated = true;

    if (event.http !== undefined) {
      out.http =
        typeof event.http === "object" && event.http !== null
          ? { ...event.http, url: sanitizeUrl(event.http.url, opts) }
          : event.http;
    }

    if (event.error !== undefined) {
      const source = event.error;
      if (typeof source === "object" && source !== null) {
        const error: Record<string, unknown> = {
          message: m === "shape" && typeof source.message === "string" ? scrubMessage(source.message) : source.message,
        };
        if (source.code !== undefined) error.code = source.code;
        if (source.issues !== undefined) {
          error.issues = m === "full" ? sanitize(source.issues, opts).value : issueShape(source.issues);
        }
        if (m === "full" && env.APP_ENV === "development" && source.stack !== undefined) {
          error.stack = source.stack;
        }
        out.error = error;
      } else {
        out.error = source;
      }
    }

    const parsed = InspectorEventSchema.safeParse(out);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
