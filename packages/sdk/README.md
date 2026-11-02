# @prashant-rajpurohit/trpc-inspector-sdk

Server-side SDK for trpc-inspector. Captured events stay in memory, are sanitized in-process, and go only to the local bridge on `127.0.0.1`.

## tRPC server middleware

Requires `@trpc/server` v11 (peer dependency). It is a separate entry point, so the main entry never loads tRPC:

```ts
import { initTRPC } from "@trpc/server";
import { inspectorMiddleware } from "@prashant-rajpurohit/trpc-inspector-sdk/trpc";

const t = initTRPC.context<Ctx>().create();
export const publicProcedure = t.procedure.use(t.middleware(inspectorMiddleware()));
```

Put it first in the chain, on the base procedure everything else builds on.

Options:

- `getHttpInfo(ctx) => { url, method } | undefined`. By default it reads `ctx.req.url` and `ctx.req.method` when your context has a `req` (fetch `Request` or Node `IncomingMessage`). Headers, cookies and the request body are never read. Supply this option if your context keeps the request under another name.

### Enabling

The middleware does nothing beyond one cached boolean check unless `TRPC_INSPECTOR=1` **and** `APP_ENV` is `development` or `uat`. `NODE_ENV` is ignored. When the gate is off, `ws` is never loaded and no connection is attempted.

Values are reduced to their shape by default. Full values (still redacted and size-capped) are sent only when `APP_ENV=development` and `TRPC_INSPECTOR_MODE=full`.

**The gate and mode are read once per process.** Changing `TRPC_INSPECTOR`, `APP_ENV` or `TRPC_INSPECTOR_MODE` needs a server restart.

### What is captured

Each execution produces a `pending` event and then a `success` or `error` event with the same `id`. The bridge keeps one entry per `id`. Events include the path, type, raw input, output or error (code, message, validation issues, stack), duration and, when available, the HTTP URL and method.

Covered automatically, for every procedure built from the instrumented base procedure (including procedures derived from it, such as `protectedProcedure = publicProcedure.use(auth)`):

- HTTP requests through any adapter (fetch, Next.js, standalone, Express). Each call in a batch is a separate event.
- Direct server calls that never touch HTTP: `t.createCallerFactory(router)`, `router.createCaller`, Server Components, and prefetch or hydration helpers that call procedures through a caller.
- Input validation failures (`BAD_REQUEST`). The middleware runs before `.input()` parsing and records the raw input. Issues are kept in full in full mode; shape mode keeps only each issue's `code` and `path`.
- Unreadable input (for example malformed JSON in the query string): the event is recorded without `input`.

Not covered:

- Procedures created from `t.procedure` directly, or from any base that does not include the middleware. A router (or `createCaller` on a router) whose procedures bypass `publicProcedure` is invisible.
- Procedures from a separate `initTRPC` instance merged into the router, unless that instance's base procedure is instrumented too.
- Failures before a procedure is resolved, such as an unknown path, a wrong HTTP method, or a malformed batch request.
- Anything a middleware placed **before** the inspector rejects. `durationMs` also excludes time spent in those middlewares.
- **Subscriptions:** only the start (`pending`) and an `error` when setup fails are captured. Streamed messages, completion and unsubscribe are not, so a running subscription stays `pending`.
- HTTP response status (`http.status`), batch position, and changes made by an error formatter or response transformer. The output is captured before serialization.
- When the context has no `req` (and no `getHttpInfo` is given), HTTP calls are recorded without `http`.

The middleware never changes a procedure's result, error or control flow. It returns exactly what `next()` returned and rethrows anything thrown. Every instrumentation step is wrapped so that a failure only loses the event. With the bridge down, events wait in a bounded memory queue and procedures run as usual.
