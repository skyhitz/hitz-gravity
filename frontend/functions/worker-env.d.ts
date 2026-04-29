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
}
