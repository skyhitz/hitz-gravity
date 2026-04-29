// Ambient declaration for Cloudflare's `cloudflare:email` runtime module.
// Kept in a separate script-mode .d.ts (no top-level import/export) so
// `declare module` registers a wholly new module rather than augmenting an
// existing one. Narrow on purpose — we only use EmailMessage.

declare module "cloudflare:email" {
  export class EmailMessage {
    constructor(from: string, to: string, raw: string | ReadableStream);
    readonly from: string;
    readonly to: string;
  }
}
