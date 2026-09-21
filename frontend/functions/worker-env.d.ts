// Minimal type declarations for the Cloudflare Workers runtime.
//
// The full @cloudflare/workers-types package is ~300KB and overrides a
// bunch of DOM lib globals in ways that conflict with the Next.js client-
// side code in this same repo. We only use a handful of types from it, so
// we redeclare them locally. Kept intentionally narrow — if we need more
// surface (Durable Objects, R2, etc.) we'd pull in the proper package
// with isolated scoping.

export {};

declare global {
  interface SendEmail {
    send(message: import("cloudflare:email").EmailMessage): Promise<void>;
  }

  interface KVNamespace {
    get(key: string, options?: { type?: "text" }): Promise<string | null>;
    get(key: string, options: { type: "json" }): Promise<unknown | null>;
    put(
      key: string,
      value: string | ReadableStream | ArrayBuffer,
      options?: { expirationTtl?: number; expiration?: number; metadata?: unknown }
    ): Promise<void>;
    delete(key: string): Promise<void>;
  }

  // Cloudflare's per-colo HTTP cache.
  interface CacheStorage {
    readonly default: Cache;
  }

  interface ExecutionContext {
    waitUntil(promise: Promise<unknown>): void;
    passThroughOnException(): void;
  }

  // Cron Trigger invocation (see [triggers] in wrangler.toml).
  interface ScheduledController {
    readonly scheduledTime: number;
    readonly cron: string;
    noRetry(): void;
  }

  // D1 — only the surface the data layer uses.
  interface D1Result<T = Record<string, unknown>> {
    results: T[];
    success: boolean;
    meta: { changes?: number; last_row_id?: number; rows_read?: number; rows_written?: number };
  }

  interface D1PreparedStatement {
    bind(...values: unknown[]): D1PreparedStatement;
    first<T = Record<string, unknown>>(column?: string): Promise<T | null>;
    all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
    run(): Promise<D1Result>;
  }

  interface D1Database {
    prepare(query: string): D1PreparedStatement;
    batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
  }
}
